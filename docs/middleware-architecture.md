# Architecture interne d'Express Token Revoker

> Analyse synthétique du fonctionnement interne — couches, flux, cycle de vie.
>
> **Scope** : ce document décrit le package `express-token-revoker` en mode **standalone (single-process)**.
> Il ne couvre pas le mode distribué (packages `server` / `node`, planifiés).

---

## 1. Vue d'ensemble

Le middleware est un **système de révocation de tokens** basé sur un **filtre de Bloom** avec rotation automatique et persistance crash-safe. Il existe en deux modes :

- **Mode JWT** : vérifie des *claims* spécifiques (`jti`, `sub`, etc.) contre le filtre
- **Mode opaque** : vérifie un token brut ou une clé d'API depuis un header HTTP

**Propriété fondamentale** : si `has(token) → false`, le token n'est **définitivement pas** révoqué. Si `true`, il est **peut-être** révoqué (faux positifs possibles selon le FPR configuré). Il n'y a **jamais** de faux négatif (un token révoqué est toujours détecté).

---

## 2. Architecture en couches (bottom-up)

```
┌──────────────────────────────────────────────────────────────┐
│                     Revoker (index.ts)                       │
│   Public API facade : createRevoker(), add(), getMiddleware()│
│   Wiring + cycle de vie gRPC + graceful shutdown             │
├──────────────────────────────────────────────────────────────┤
│              createMiddlewares.ts                            │
│   ┌──────────────────┐  ┌───────────────────────┐            │
│   │ createJWTMid..   │  │ createOpaqueMid..     │            │
│   │ claimsToCheck[]  │  │ opaqueHeader          │            │
│   │ → jti, sub, ...  │  │ → Authorization       │            │
│   └────────┬─────────┘  └──────────┬────────────┘            │
│            │  req[payloadKey]      │  req.headers[header]    │
│            ▼                       ▼                         │
│      401 / 400 / 500         401 / 400 / 500                 │
│      ou next()               ou next()                       │
├──────────────────────────────────────────────────────────────┤
│              BloomFilterManager                              │
│   ┌───────────────────────────────────────────────┐          │
│   │  current: BloomFilter    previous: BloomFilter│          │
│   │         ▲                        ▲            │          │
│   │    ┌────┴────┐             (issu de rotation) │          │
│   │    │  add()  │  has() = current.test()        │          │
│   │    │  has()  │       || previous.test()       │          │
│   │    └────┬────┘                                │          │
│   │  rotation interval (setInterval, rotateTime)  │          │
│   │  saturation guard (>10x → blocage add())      │          │
│   │  mutex (async-mutex) pour rotate concurrent   │          │
│   │  healthCheck(), getMetrics(), shutdown()      │          │
│   └───────────────────────────────────────────────┘          │
├──────────────────────────────────────────────────────────────┤
│           BloomFilterBackupManager                           │
│   ┌──────────────────────────────────────────────┐           │
│   │  WAL: backupItem() → fs.appendFileSync()     │           │ 
│   │       temp-<id>.txt (1 token par ligne)      │           │
│   │                                              │           │
│   │  Full backup: backupLocal() → blob binaire   │           │
│   │       current-<id>.blob (écriture atomique:  │           │
│   │       .tmp → fsync → rename)                 │           │
│   │                                              │           │
│   │  Rotation: backupRotate() → backupLocal()    │           │
│   │       + rename(current → previous)           │           │
│   │                                              │           │
│   │  Restore: restore() → lit .blob + replay WAL │           │
│   │                                              │           │
│   │  Buffer (optionnel): writeBuffer[] → flush   │           │
│   │       asynchrone toutes les 1s               │           │
│   └──────────────────────────────────────────────┘           │
├──────────────────────────────────────────────────────────────┤
│  BloomFilterFactory  │  bloomfilter.ts (Jason Davies, BSD)   │
│  create(numItems,    │  Int32Array buckets + k hash fns      │
│    fpRate)           │  add(), test(), size(), error()       │
├──────────────────────────────────────────────────────────────┤
│  Support: Inputs-validation (Joi) · errors (typed)           │
│           throttle (logOrThrottle) · revokerStore (gRPC)     │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Flux requête HTTP — le chemin critique

### Mode JWT

```
Client ─── GET /api/protected ───▶ Express

  1. Auth middleware (externe)
     • Vérifie signature JWT
     • Décode payload → req.token = { jti: "abc123", sub: "user42", exp: ... }

  2. Revoker middleware (createJWTMiddleware)
     │
     ├─ Pour chaque claim dans claimsToCheck (ex: ['jti'])
     │    (court-circuit via every() : dès qu'un claim est révoqué,
     │     les suivants ne sont pas testés) :
     │    │
     │    ├─ Extrait payload[claim] → "abc123"
     │    ├─ Construit clé: "jti-abc123"
     │    ├─ bloomFilterManager.has("jti-abc123")
     │    │      │
     │    │      ├─ current.test("jti-abc123") ──┐
     │    │      └─ previous.test("jti-abc123") ─┤ → true/false
     │    │                                       │
     │    ├─ Si true  → log throttlé + 401 { error: "invalid_token" }
     │    └─ Si false → continue au claim suivant
     │
     └─ Toutes les claims OK → next() → handler métier

  3. Handler métier → 200 { ok: true }
```

### Mode Opaque

```
Client ─── GET /api/protected ───▶ Express
  Header: Authorization: Bearer sk-abcdef12345

  1. Revoker middleware (createOpaqueMiddleware)
     │
     ├─ Extrait le token depuis req.headers[header]
     │    • Si header = "authorization" → parse "Bearer <token>"
     │    • Sinon → prend la valeur brute
     │
     ├─ bloomFilterManager.has("sk-abcdef12345")
     │    → Si true  → 401 { error: "invalid_token" }
     │    → Si false → next()
```

### Gestion des erreurs dans les middlewares

| Scénario | HTTP | Détail |
| ---------- | ------ | -------- |
| Token révoqué (trouvé dans le filtre) | 401 | `invalid_token` |
| Payload/header manquant ou malformé | 400 | `validation_error` |
| Erreur interne inattendue | 500 | `internal_error` |

---

## 4. Flux de révocation + persistance

```
Admin ─── POST /admin/revoke/jti-abc123 ───▶ Revoker.add("jti-abc123")

  ┌──────────────────────────────────────────────────────────┐
  │  1. Validation                                           │
  │     • Non-empty string                                   │
  │     • Pas de \r \n \0 (empoisonnerait le WAL)            │
  │     • ≤ 4096 caractères                                  │
  │     • Vérification saturation (>10x → erreur)            │
  │     • Vérification shutdown en cours                     │
  ├──────────────────────────────────────────────────────────┤
  │  2. Persistance WAL (AVANT mise à jour mémoire)          │
  │                                                          │
  │     Si bufferEnabled=false (sync):                       │
  │       fs.appendFileSync(temp-<id>.txt, "jti-abc123\n")   │
  │       → 3 retries, puis exception + stderr d'audit       │
  │       → latence ~9µs (SATA SSD)                          │
  │                                                          │
  │     Si bufferEnabled=true (async):                       │
  │       writeBuffer.push("jti-abc123")                     │
  │       → flush toutes les 1s vers temp-<id>.txt           │
  │       → si buffer plein → erreur                         │
  ├──────────────────────────────────────────────────────────┤
  │  3. Mise à jour mémoire                                  │
  │       current.add("jti-abc123")                          │
  │       → k fonctions de hash → positionne k bits          │
  │       → #currentInsertions++                             │
  │       → compteur addSucceeded++                          │
  └──────────────────────────────────────────────────────────┘
```

> **Pourquoi synchrone ?** Le WAL est écrit en `appendFileSync` *avant* la mise à jour mémoire. Si le processus crash entre les deux, le token est dans le fichier et sera rejoué au redémarrage. L'ordre inverse (mémoire d'abord, fichier ensuite) risquerait de perdre des révocations.

> **Truncation du WAL** : après un `backupLocal()` réussi (blob écrit + fsync + rename), le WAL est **tronqué** (`writeFile(tempPath, '')`). Les tokens sont désormais dans le blob binaire ; le WAL ne contient plus que les ajouts postérieurs au dernier backup. C'est le generation counter qui protège cette truncation : si une rotation survient entre le schedule du backup et son exécution, le backup stale est ignoré et le WAL n'est pas tronqué à tort.

---

## 5. Cycle de rotation (time-driven)

```
                  rotateTime (ex: 10 min)

    ┌──────────────────────────────────────────────────┐
    │                                                  │
    ▼                                                  │
 ┌──────┐     ┌──────┐     ┌──────┐     ┌──────┐
 │ T₀   │     │ T₁   │     │ T₂   │     │ T₃   │
 │      │     │      │     │      │     │      │
 │ cur  │ ──▶ │ prev │     │      │     │      │
 │      │ rot │ cur  │ ──▶ │ prev │     │      │
 │      │     │      │ rot │ cur  │ ──▶ │ prev │
 │      │     │      │     │      │ rot │ cur  │
 └──────┘     └──────┘     └──────┘     └──────┘

  has() vérifie TOUJOURS current ET previous
  → un token révoqué dans T₀ est vérifié dans T₀ (current)
    ET dans T₁ (previous) → 2 fenêtres de couverture
```

**Propriété de sûreté** : si `rotateTime` = durée de vie du token (TTL JWT), alors un token révoqué est vérifié pendant toute sa durée de vie résiduelle, puis expiré naturellement. La mémoire reste bornée — pas de croissance infinie.

### Robustesse de la rotation

- **3 tentatives** avec délai de 5s en cas d'échec
- Si les 3 tentatives échouent → attend le prochain tick d'intervalle
- **L'intervalle n'est jamais arrêté** définitivement
- La rotation continue **en mémoire même si le backup disque échoue**

### Saturation du filtre

| Ratio (insertions / numItems) | État | Comportement |
| ------------------------------- | ------ | -------------- |
| ≤ 2× | Sain | Normal |
| 2× – 10× | Dégradé (`healthy=true`) | FPR élevé, warning dans health check |
| > 10× | Critique (`healthy=false`) | `add()` **bloqué** |

---

## 6. Reprise après crash

```
Redémarrage du processus
  │
  ├─ 1. Restauration des blobs binaires
  │      current-<id>.blob → BloomFilterFactory.createFromBuckets()
  │      previous-<id>.blob → idem
  │      Vérification geometry : taille blob doit matcher (numItems, fpRate)
  │      → Si mismatch → warning, filtre vide
  │
  └─ 2. Replay du WAL (temp-<id>.txt)
         Pour chaque ligne du fichier :
           current.add(ligne)
         Lignes malformées → skip + warning
```

### Fenêtre de perte de données

| Mode | Fenêtre de perte |
| ------ | ----------------- |
| Sync (`bufferEnabled: false`) | ~0 contre un **crash process** (le syscall `appendFileSync` est synchrone — le kernel a les données). Contre une **coupure de courant / crash kernel**, petite fenêtre : le page cache n'est pas fsyncé à chaque écriture. |
| Buffer (`bufferEnabled: true`) | ≤ 1s (intervalle de flush du buffer) + même fenêtre page cache que le mode sync lors du flush |

---

## 7. Diagramme global des composants

```
                           ┌──────────────┐
                           │   Client     │
                           └──────┬───────┘
                                  │ HTTP
                           ┌──────▼───────┐
                           │   Express    │
                           │   Auth MW    │  ← externe (vérifie signature JWT)
                           │   Revoker MW │  ← getMiddleware()
                           │   Handler    │
                           └──────┬───────┘
                                  │
                    ┌─────────────┼─────────────┐
                    │             │             │
              ┌─────▼─────┐ ┌────▼────┐ ┌──────▼────────┐
              │  Revoker  │ │  gRPC   │ │ Health/Metrics│
              │  .add()   │ │  Admin  │ │  endpoints    │
              └─────┬─────┘ └─────────┘ └───────────────┘
                    │
           ┌────────▼─────────┐
           │ BloomFilterMgr   │
           │ ┌───────┐┌──────┐│
           │ │current││ prev ││
           │ └──┬────┘└──────┘│
           └────┼─────────────┘
                │
      ┌─────────┼─────────┐
      │         │         │
┌─────▼────┐ ┌──▼───┐ ┌──▼──────────┐
│  WAL     │ │ Blob │ │  Buffer      │
│  temp.txt│ │ .blob│ │ (optionnel)  │
│  sync    │ │ atom.│ │  async 1s    │
└──────────┘ └──────┘ └──────────────┘
```

---

## 8. Cycle de vie complet

```
createRevoker(config)
  │
  ├─ 1. Validation Joi (revokerInputSchema)
  │
  ├─ 2. new BloomFilterManager(filterConfig)
  │     ├─ Validation Joi (filterInputSchema)
  │     ├─ Création filtre courant (BloomFilterFactory.create)
  │     ├─ Si backup: restauration depuis disque (blob + WAL)
  │     ├─ Démarrage intervalle de rotation (setInterval)
  │     └─ Si backup + backupRatioTime: démarrage backup périodique
  │
  ├─ 3. Création middleware (JWT ou Opaque)
  │
  ├─ 4. Si gRPC: _grpcInit()
  │     ├─ Démarrage serveur gRPC (singleton process-wide)
  │     └─ Enregistrement dans revokerStore
  │
  └─ 5. Retourne l'instance Revoker

...

shutdown()
  │
  ├─ 1. Marque #shuttingDown = true → add() rejeté
  ├─ 2. Attend la fin de la rotation en cours (mutex)
  ├─ 3. Flush final du buffer (si bufferEnabled)
  ├─ 4. destroy() → stop intervals, libère mémoire
  └─ 5. Nettoyage gRPC → unregister, stop server si dernier
```

---

## 9. Arbre des fichiers source

```
packages/core/src/
├── index.ts                    ← Point d'entrée public : createRevoker(), Revoker
├── createMiddlewares.ts        ← Fabriques de middlewares Express (JWT + Opaque)
├── Bloom-filter-manager.ts     ← Orchestrateur : rotation, add/has, saturation
├── BloomFilterBackupManager.ts ← Persistance : WAL, blobs, buffer, restore
├── BloomFilterFactory.ts       ← Fabrique statique de BloomFilter
├── bloomfilter.ts              ← Implémentation du filtre de Bloom (Jason Davies)
├── Inputs-validation.ts        ← Schémas Joi (revoker + filter)
├── errors.ts                   ← ValidationError, InternalError
├── throttle.ts                 ← logOrThrottle (log throttlé en prod)
├── revokerStore.ts             ← Singleton Map pour instances gRPC
└── grpc/
    ├── protos/revoker.proto    ← Définition du service gRPC
    ├── std-server.ts           ← Implémentation serveur gRPC
    ├── std-client.ts           ← Client gRPC (callback)
    └── std-client-async.ts     ← Client gRPC (async/promisifié)
```

---

## 10. Points de conception notables

- **WAL avant mémoire** : `appendFileSync` avant `current.add()` — garanti qu'un crash ne perd jamais de révocations
- **Rotation time-driven, pas count-driven** : `numItems` dimensionne le filtre, ne déclenche pas la rotation — c'est `rotateTime` qui la pilote
- **Deux filtres (current + previous)** : `has()` teste les deux — garantit qu'un token révoqué juste avant une rotation reste détecté
- **Écriture blob atomique** : `.tmp` → `fsync` → `rename` — un crash ne peut pas laisser un blob tronqué
- **Mutex sur la rotation** : `async-mutex` empêche les races entre `rotate()` et les backups périodiques
- **Génération counter** : invalide les backups périodiques stale quand une rotation survient entre le schedule et l'exécution
- **Saturation guard** : bloque `add()` au-delà de 10× la capacité — évite l'effondrement du FPR
- **Graceful degradation** : la rotation continue en mémoire même si le disque est indisponible
- **Log throttling** : en production, les logs de tokens blacklistés sont throttlés à 1 par minute pour éviter le flood
- **Redaction** : les tokens dans les logs sont hashés (SHA256 tronqué à 8 chars) — jamais en clair
- **`union()` / `intersection()`** : `bloomfilter.ts` expose ces opérations statiques (même `m`, `k` requis). Non utilisées dans le code actuel — primitives probables pour la synchronisation inter-nœuds en mode distribué
- **`revokerStore` singleton** : point de couture évident pour le mode distribué — actuellement limité à un registry process-local
