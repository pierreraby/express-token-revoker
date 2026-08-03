# Architecture distribuée — Pistes de conception

> Note de réflexion sur l'extension multi-nœuds d'Express Token Revoker.
> Fait suite à l'analyse du mode standalone (`middleware-architecture.md`).

---

## La tension fondamentale

La révocation distribuée a un invariant non négociable : **pas de faux négatif**. Un token révoqué doit être détecté partout. Mais la distribution introduit inévitablement un **délai de propagation** — pendant lequel un nœud qui n'a pas encore reçu la révocation va accepter le token.

Toute l'architecture se résume à une question : **comment rendre cette fenêtre aussi petite et prévisible que possible, sans trahir la philosophie du projet** (pas de dépendance externe, crash-safe, simple à auditer) ?

---

## Modèle recommandé : coordinateur + streaming du WAL

C'est l'extension la plus naturelle de l'existant.

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

3. **Le coordinateur orchestre la rotation.** Il envoie un signal `RotateRequest{generation: N}`. Les nœuds rotatent localement. Les entrées WAL sont tagguées par génération, donc un nœud qui reçoit une entrée de la gen N-2 sait dans quel filtre la mettre. Le generation counter existant s'étend naturellement.

4. **Crash-safety locale préservée.** Chaque nœud a son propre WAL local. Si un nœud crash, il redémarre avec son blob + son WAL local, puis se resynchronise avec le coordinateur pour les entrées manquantes. Le modèle de reprise (§6 de `middleware-architecture.md`) reste valable par nœud.

5. **Pas de dépendance externe.** Pas de Redis, pas de base. Juste du gRPC déjà présent.

---

## Les 4 décisions de conception critiques

### 1. Push (stream) vs Pull (poll)

| | Push (gRPC stream) | Pull (poll périodique) |
| --- | --- | --- |
| Latence propagation | <100ms LAN | = intervalle de poll (secondes) |
| Complexité | Stream + reconnexion | Simple requête/réponse |
| Détection déconnexion | Immédiate (stream cassé) | Au prochain poll |
| Fenêtre de vulnérabilité | Très petite | Bornée par l'intervalle |

**Recommandation** : push en primaire, pull en fallback. Le stream gRPC donne une propagation quasi-instantanée. Si le stream casse, le nœud passe en mode dégradé et poll jusqu'à reconnexion. C'est le pattern "connected mode / degraded mode" déjà utilisé pour le disque.

### 2. Qui décide la rotation ?

**Le coordinateur, exclusivement.** Si chaque nœud rotate à son propre `rotateTime`, les filtres divergent (décalage de quelques ms → entrées dans le mauvais filtre → faux négatifs possibles à la frontière). Le coordinateur envoie `RotateRequest{generation: N}` et les nœuds obéissent.

Conséquence : `rotateTime` devient un paramètre du coordinateur, pas des nœuds. Les nœuds ont un `rotateTimeout` de sécurité (si pas de signal du coordinateur après 2× rotateTime, ils rotatent seuls et loggent un warning — mode dégradé).

### 3. Cohérence au démarrage d'un nouveau nœud

Un nœud qui rejoint le cluster a besoin de l'état complet. Deux options :

- **Snapshot + delta** : le coordinateur envoie ses blobs current/previous (sérialisés), puis le nœud se met à écouter le stream. Simple, mais le blob peut être gros (5 MB pour 1M items à fpRate=1e-9).
- **Replay complet du WAL** : le nœud rejoue tout le WAL depuis le début. Plus lent mais cohérent.

**Recommandation** : snapshot + delta. Le coordinateur a déjà les blobs. Envoyer 5-10 MB au démarrage d'un nœud, c'est rien. Et le nœud peut vérifier la géométrie du blob comme il le fait déjà localement.

### 4. Que fait un nœud si le coordinateur est down ?

**Il continue.** Principe de graceful degradation déjà appliqué pour le disque. Le nœud a son filtre local, son WAL local. Il continue de servir les checks de révocation. Il ne peut plus recevoir de nouvelles révocations (ou alors en mode dégradé avec un buffer local qui sera flushé à la reconnexion), mais les révocations existantes sont toujours détectées.

C'est le même trade-off que le WAL sync : on privilégie la sûreté (pas de faux négatif sur l'état connu) sur la disponibilité (nouvelles révocations en attente).

---

## Ce qu'on évite

- **Gossip / anti-entropy avec `union()`** : séduisant sur le papier, mais `union()` est lossy (on ne sait plus qui a ajouté quoi), ça gonfle le FPR, et la convergence est lente. Pour de la révocation où on veut une propagation rapide et traçable, le log central est supérieur. `union()` reste utile pour du debug ou de la vérification de cohérence ("mon filtre est-il un sous-ensemble du filtre du coordinateur ?").

- **Un store partagé (Redis, Postgres)** : trahit la philosophie du projet et déplace le problème (le store devient le SPOF). Le coordinateur gRPC est plus léger et plus contrôlable.

- **La rotation indépendante par nœud** : porte aux faux négatifs à la frontière de rotation.

---

## Rôle des packages

| Package | Rôle |
| --- | --- |
| `packages/core` | Inchangé. Filtre, WAL, rotation locale, middlewares. Brique de base. |
| `packages/server` | Coordinateur. Reçoit les `add()`, écrit le WAL canonique, stream les deltas, orchestre la rotation, sert les snapshots. |
| `packages/node` | Participant. Écoute le stream, maintient son filtre local, expose le middleware Express. En mode dégradé, buffer local + poll. |

`core` ne connaît pas la distribution. `node` wrappe `core` et ajoute la couche réseau. `server` wrappe `core` et ajoute la coordination. Séparation propre.

---

## Invariants locaux vs globaux

Pour la réflexion, voici la distinction à garder en tête :

| Invariant | Scope standalone | Scope distribué |
| --- | --- | --- |
| Pas de faux négatif | Local (WAL avant mémoire) | **Global** — chaque nœud doit avoir reçu la révocation avant de pouvoir accepter le token |
| WAL avant mémoire | Local (syscall sync) | Local par nœud + WAL canonique au coordinateur |
| Rotation jamais arrêtée | Local (setInterval + retry) | **Coordonnée** — le coordinateur décide, les nœuds obéissent (avec timeout de sécurité) |
| Saturation guard | Local (10× numItems) | Local par nœud (même filtre, même ratio) |
| Pas de tokens en clair dans les logs | Local (redactToken) | Identique, inchangé |
| Blob atomique | Local (fsync + rename) | Local par nœud + snapshot coordinateur |

---

## `union()` / `intersection()` — rôle dans le distribué

Ces primitives existent dans `bloomfilter.ts` mais ne sont pas utilisées dans le code actuel.

- **`union()`** : fusionne deux filtres (même `m`, `k` requis). Pas adapté à la synchronisation courante (lossy, gonfle le FPR). Utile pour : vérification de cohérence, debug, rattrapage rapide d'un nœud très en retard.
- **`intersection()`** : intersection de deux filtres. Utile pour : vérifier qu'un nœud contient au moins les révocations du coordinateur (subset check approximatif).

Le modèle recommandé (WAL shipping) n'en a pas besoin pour le fonctionnement nominal.
