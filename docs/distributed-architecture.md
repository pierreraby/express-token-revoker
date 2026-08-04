# Architecture distribuée — Conception & implémentation v1

> Documentation de l'extension multi-nœuds d'Express Token Revoker.
> Fait suite à l'analyse du mode standalone (`middleware-architecture.md`).
>
> La v1 est **implémentée** (`packages/server` + `packages/node`) et les
> décisions produit sont **actées** — voir [Décisions actées](#décisions-actées-v1)
> et [Implémentation v1](#implémentation-v1).

---

## La tension fondamentale

La révocation distribuée a un invariant non négociable : **pas de faux négatif**. Un token révoqué doit être détecté partout. Mais la distribution introduit inévitablement un **délai de propagation** — pendant lequel un nœud qui n'a pas encore reçu la révocation va accepter le token.

Toute l'architecture se résume à une question : **comment rendre cette fenêtre aussi petite et prévisible que possible, sans trahir la philosophie du projet** (pas de dépendance externe, crash-safe, simple à auditer) ?

---

## Décisions actées (v1)

| Réf | Décision | Détail |
| --- | --- | --- |
| **PD-1** | ✅ **Authentification du lien coordinateur↔nœuds** | 3 modes : `shared-secret` (**par défaut** : TLS unidirectionnel + secret partagé en metadata gRPC), `mtls` (TLS mutuel), `insecure` (dev uniquement, explicite, loopback seul). `scripts/gen-certs.mjs` génère le matériel TLS. Voir la [table des modes](#authentification-pd-1). |
| **PD-2** | ✅ **Mode dégradé : les nœuds REFUSENT les nouvelles révocations** | Coordinateur down ⇒ les nœuds continuent de servir les checks depuis leur état local, mais `add()` lève toujours une erreur (les révocations sont coordinator-only). Pas de buffer local à réconcilier. |
| **PD-3** | ✅ **Packaging : packages privés pour l'instant** | `@express-token-revoker/server` et `@express-token-revoker/node` sont `private: true` (non publiés) tant que l'API n'est pas stabilisée. Seul `packages/core` est publié. |

---

## Modèle : coordinateur + streaming du WAL

C'est l'extension la plus naturelle de l'existant — c'est le modèle implémenté en v1.

```
                    ┌──────────────────────┐
                    │   Coordinator        │
                    │   (packages/server)  │
                    │                      │
  Admin ──add()──▶  │  • WAL canonique     │
                    │  • Filtres current/  │
                    │    previous          │
                    │  • Orchestre rotation│
                    │  • Stream les deltas │
                    └──────┬──────┬────────┘
                           │      │  gRPC stream (push)
                    ┌──────▼──┐ ┌─▼───────┐
                    │ Node A  │ │ Node B  │  ...
                    │ (pkg/   │ │         │
                    │  node)  │ │         │
                    │         │ │         │
                    │ Filtre  │ │ Filtre  │
                    │ local   │ │ local   │
                    │ WAL     │ │ WAL     │
                    │ local   │ │ local   │
                    │         │ │         │
                    │ MW Express          │
                    │ (check local)       │
                    └─────────┘ └─────────┘
```

### Pourquoi ce modèle

1. **Le WAL est déjà un log de réplication.** Append-only, ordonné, une entrée par ligne. Shipper le WAL aux nœuds, c'est de la réplication log-structured — le modèle le plus éprouvé (Kafka, Postgres WAL shipping, etc.). On n'invente rien, on étend.

2. **Chaque nœud construit son propre filtre indépendamment** en rejouant le même log. Pas besoin de `union()` — les filtres sont identiques parce qu'ils ont la même histoire. Plus simple, et le FPR garanti est préservé (pas de fusion qui gonfle le filtre).

3. **Le coordinateur orchestre la rotation.** Il envoie un signal `Rotate{generation: N}`. Les nœuds rotatent localement. Les entrées WAL sont tagguées par génération, donc un nœud qui reçoit une entrée de la gen N-2 sait dans quel filtre la mettre. Le generation counter existant s'étend naturellement.

4. **Crash-safety locale préservée.** Chaque nœud a son propre WAL local. Si un nœud crash, il redémarre avec son blob + son WAL local, puis se resynchronise avec le coordinateur pour les entrées manquantes. Le modèle de reprise (§6 de `middleware-architecture.md`) reste valable par nœud.

5. **Pas de dépendance externe.** Pas de Redis, pas de base. Juste du gRPC déjà présent.

---

## Les 4 décisions de conception critiques

Toutes sont **actées** et implémentées en v1.

### 1. Push (stream) vs Pull (poll)

| | Push (gRPC stream) | Pull (poll périodique) |
| --- | --- | --- |
| Latence propagation | <100ms LAN | = intervalle de poll (secondes) |
| Complexité | Stream + reconnexion | Simple requête/réponse |
| Détection déconnexion | Immédiate (stream cassé) | Au prochain poll |
| Fenêtre de vulnérabilité | Très petite | Bornée par l'intervalle |

**Actée (v1)** : push en primaire, poll en fallback. Le stream gRPC donne une propagation quasi-instantanée. Si le stream casse, le nœud passe en mode dégradé et poll jusqu'à reconnexion. C'est le pattern "connected mode / degraded mode" déjà utilisé pour le disque.

### 2. Qui décide la rotation ?

**Actée (v1) : le coordinateur, exclusivement.** Si chaque nœud rotate à son propre `rotateTime`, les filtres divergent (décalage de quelques ms → entrées dans le mauvais filtre → faux négatifs possibles à la frontière). Le coordinateur envoie `Rotate{generation: N}` et les nœuds obéissent.

Conséquence : `rotateTime` devient un paramètre du coordinateur, pas des nœuds. Les nœuds ont un timeout de sécurité (`rotateTime × safetyFactor`, facteur ≥ 2, défaut 2.5) : sans rotation coordonnée pendant toute cette fenêtre, le core du nœud rotate seul — une **auto-rotation dégradée** détectée et marquée `dirty` (voir [Récupération](#récupération)).

### 3. Cohérence au démarrage d'un nouveau nœud

Un nœud qui rejoint le cluster a besoin de l'état complet. Deux options :

- **Snapshot + delta** : le coordinateur envoie ses blobs current/previous (sérialisés), puis le nœud se met à écouter le stream. Simple, mais le blob peut être gros (5 MB pour 1M items à fpRate=1e-9).
- **Replay complet du WAL** : le nœud rejoue tout le WAL depuis le début. Plus lent mais cohérent.

**Actée (v1)** : snapshot + delta. Le coordinateur a déjà les blobs. Envoyer 5-10 MB au démarrage d'un nœud, c'est rien. Et le nœud peut vérifier la géométrie du blob comme il le fait déjà localement.

### 4. Que fait un nœud si le coordinateur est down ?

**Actée (v1, PD-2) : il continue de servir les checks — et refuse les nouvelles révocations.** Le nœud a son filtre local, son WAL local : les révocations existantes sont toujours détectées. En revanche `add()` lève toujours une erreur : les révocations sont coordinator-only, et bufferiser au nœud exigerait une réconciliation de LSN à la reconnexion.

C'est le même trade-off que le WAL sync : on privilégie la sûreté (pas de faux négatif sur l'état connu) sur la disponibilité (nouvelles révocations en attente).

---

## Ce qu'on évite

- **Gossip / anti-entropy avec `union()`** : séduisant sur le papier, mais `union()` est lossy (on ne sait plus qui a ajouté quoi), ça gonfle le FPR, et la convergence est lente. Pour de la révocation où on veut une propagation rapide et traçable, le log central est supérieur. `union()` reste utile pour du debug ou de la vérification de cohérence ("mon filtre est-il un sous-ensemble du filtre du coordinateur ?").

- **Un store partagé (Redis, Postgres)** : trahit la philosophie du projet et déplace le problème (le store devient le SPOF). Le coordinateur gRPC est plus léger et plus contrôlable.

- **La rotation indépendante par nœud** : porte aux faux négatifs à la frontière de rotation.

---

## Rôle des packages

| Package | Rôle | Publication |
| --- | --- | --- |
| `packages/core` | Inchangé. Filtre, WAL, rotation locale, middlewares. Brique de base. | ✅ Publié |
| `packages/server` | Coordinateur (`@express-token-revoker/server`). Reçoit les `add()`, écrit le WAL canonique, stream les deltas, orchestre la rotation, sert les snapshots. | 🔒 Privé (PD-3) |
| `packages/node` | Participant (`@express-token-revoker/node`). Écoute le stream, maintient son filtre local, expose le middleware Express. En mode dégradé : poll + refus des nouvelles révocations (PD-2). | 🔒 Privé (PD-3) |

`core` ne connaît pas la distribution. `node` wrappe `core` et ajoute la couche réseau. `server` wrappe `core` et ajoute la coordination. Séparation propre.

---

## Invariants locaux vs globaux

Pour la réflexion, voici la distinction à garder en tête :

| Invariant | Scope standalone | Scope distribué |
| --- | --- | --- |
| Pas de faux négatif | Local (WAL avant mémoire) | **Global** — chaque nœud doit avoir reçu la révocation avant de pouvoir accepter le token |
| WAL avant mémoire | Local (syscall sync) | Local par nœud + WAL canonique au coordinateur (canonical-first : l'entrée est appendée au WAL **avant** d'être appliquée au filtre) |
| Rotation jamais arrêtée | Local (setInterval + retry) | **Coordonnée** — le coordinateur décide, les nœuds obéissent (avec timeout de sécurité `rotateTime × safetyFactor`) |
| Saturation guard | Local (10× numItems) | Local par nœud (même filtre, même ratio) |
| Pas de tokens en clair dans les logs | Local (redactToken) | Identique, inchangé |
| Blob atomique | Local (fsync + rename) | Local par nœud + snapshot coordinateur |

---

## Implémentation v1

### Protocole (`distributed.proto`)

Le protocole est livré par `express-token-revoker` (core reste agnostique de la distribution) : `packages/core/src/grpc/protos/distributed.proto`.

Modèle : un **log d'événements totalement ordonné** — le coordinateur attribue un LSN (Log Sequence Number) monotone à chaque événement du WAL canonique. Les nœuds appliquent les événements séquentiellement, dans l'ordre exact de réception. Quatre types d'événements :

| Événement | Rôle |
| --- | --- |
| `WalEntry` | Une révocation (item + LSN + génération). |
| `Rotate` | Rotation coordonnée (LSN + génération N+1) — les nœuds ne rotatent que sur cet événement. |
| `Keepalive` | Maintien de vie du stream (aucun effet sur l'état). |
| `ResnapshotRequired` | Le nœud est trop en retard (floor de rétention dépassé) ⇒ il doit se re-synchroniser depuis le snapshot. |

RPCs : `Subscribe(lastLsn)` (server-streaming : backlog en ordre de LSN puis événements live), `PollDeltas(fromLsn, maxEvents)` (rattrapage paginé du mode dégradé), `GetSnapshot` (blobs + géométrie + `lastBackupLsn`), `DistAdd` / `DistHas` / `DistGetMetrics` / `ListNodes` (administration).

### Machine à états du nœud

```
                ┌────────────┐   GetSnapshot ok    ┌───────────┐
  init ────────▶│ bootstrap  │ ──────────────────▶ │ streaming │◀────────┐
                └────────────┘                     └─────┬─────┘         │
                      ▲                                  │ stream cassé  │ reconnexion
                      │ rebootstrap                      ▼               │ ok
                      │ (anomalie / dirty restart) ┌────────────────┐────┘
                      └────────────────────────────│ reconnecting   │
                                                   │ (poll + backoff│
                                                   │  1s→30s jitter)│
                                                   └────────────────┘
```

- **`bootstrap`** : `GetSnapshot` → vérification de géométrie → installation des blobs → `Subscribe(lastBackupLsn)` rejoue la queue canonique ⇒ état exact.
- **`streaming`** : stream live ouvert, événements appliqués en ordre d'arrivée.
- **`reconnecting`** (mode dégradé) : le moteur **à la fois** réessaie `Subscribe` avec backoff exponentiel 1s→30s (±20 % de jitter) **et** poll `PollDeltas` toutes les `pollIntervalMs` (défaut 2000 ms) — les deltas continuent de passer même sans stream.
- Le mode courant est exposé par `healthCheck().checks.sync` (`connected`, `mode`, `lastAppliedLsn`, `dirty`).

### Récupération

- **Bootstrap initial & redémarrage dirty** : snapshot + delta — `GetSnapshot` → vérification de géométrie (`numItems`, `fpRate` doivent correspondre à la config du nœud) → installation atomique des blobs → replay de la queue canonique depuis `lastBackupLsn`.
- **Redémarrage propre** : état de synchronisation persisté + blobs locaux ⇒ restauration core locale puis `Subscribe(lastLsn)` — pas de snapshot nécessaire.
- **Auto-rotation dégradée (dirty)** : pendant une indisponibilité prolongée du coordinateur (au-delà de `rotateTime × safetyFactor`), le core du nœud rotate seul ; le nœud marque son état `dirty`. À chaud, le moteur continue de rattraper incrémentalement à la reconnexion — c'est sûr : **aucune nouvelle révocation n'existe pendant que le coordinateur est down** (PD-2), donc aucun delta ne peut manquer. Le rebootstrap complet depuis le snapshot a lieu au **redémarrage** du nœud (init détecte le flag dirty persisté).
- **Détection de gap ⇒ rebootstrap** : aucun delta n'est jamais perdu silencieusement. Trou de LSN (`lsn ≠ dernier appliqué + 1`), génération inattendue sur un `Rotate`, `ResnapshotRequired` ou entrée inapplicable ⇒ rebootstrap bruyant depuis le snapshot (avec retry borné 1s→30s si le coordinateur est instable).

### Authentification (PD-1)

Actée et implémentée : 3 modes pour le lien gRPC coordinateur↔nœuds, configurés via le bloc `auth` de chaque package.

| Mode | Principe | Requis côté coordinateur | Requis côté nœud | Usage |
| --- | --- | --- | --- | --- |
| `shared-secret` (**défaut**) | TLS unidirectionnel + secret partagé (≥ 16 caractères) dans la metadata gRPC (`x-shared-secret`) — le pattern « API key over HTTPS » | `secret`, `caCertPath`, `serverCertPath`, `serverKeyPath` | `secret`, `caCertPath` | Déploiements réels |
| `mtls` | TLS mutuel (certificat client vérifié) en plus du secret partagé | idem `shared-secret` | idem + `clientCertPath`, `clientKeyPath` | Déploiements zero-trust |
| `insecure` | Ni TLS ni secret — opt-in explicite, warning au démarrage, bind loopback uniquement refusé au-delà | — | — | Dev/tests uniquement |

Génération du matériel TLS : `node scripts/gen-certs.mjs [--out DIR] [--days N] [--san NAME]...` (nécessite `openssl`). Produit une CA privée (`ca-cert.pem`/`ca-key.pem`), le certificat coordinateur (`server-cert.pem`/`server-key.pem`, SAN `localhost` + `127.0.0.1` + vos `--san`) et un certificat client (`client-cert.pem`/`client-key.pem`, un par nœud en mtls). Les chemins se renseignent dans le bloc `auth` de chaque config — voir les exemples `packages/server/examples/coordinator/` et `packages/node/examples/participant/`. **Ne jamais committer les `*-key.pem`.**

### Pointeurs

- Coordinateur : [`packages/server`](../packages/server/README.md) — `createCoordinator(config)` ; exemple runnable dans `packages/server/examples/coordinator/`.
- Nœud participant : [`packages/node`](../packages/node/README.md) — `createRevokerNode(config)` ; exemple runnable dans `packages/node/examples/participant/`.

---

## `union()` / `intersection()` — rôle dans le distribué

Ces primitives existent dans `bloomfilter.ts` mais ne sont pas utilisées dans le code actuel.

- **`union()`** : fusionne deux filtres (même `m`, `k` requis). Pas adapté à la synchronisation courante (lossy, gonfle le FPR). Utile pour : vérification de cohérence, debug, rattrapage rapide d'un nœud très en retard.
- **`intersection()`** : intersection de deux filtres. Utile pour : vérifier qu'un nœud contient au moins les révocations du coordinateur (subset check approximatif).

Le modèle implémenté (WAL shipping) n'en a pas besoin pour le fonctionnement nominal.
