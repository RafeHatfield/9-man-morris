# Nine Men's Morris — Game Design Document

Working title: **Morris**
Status: build-ready. This doc is the source of truth for the build; if the kickoff prompt and this doc disagree, this doc wins.

---

## 1. One-liner

A clean, mobile-first web version of Nine Men's Morris. Start a game, send a link to a friend, play online. No accounts, no lobby, no fuss.

## 2. Scope

**In**
- Standard Nine Men's Morris rules (§4), no flying phase
- Online two-player via shareable link
- Local hot-seat mode (two players, one device)
- Per-turn timer with forfeit-on-abandon
- Rematch (colours swap)
- Mobile-friendly, touch-first UI; works fine on desktop
- Hosted on Vercel; free tier only

**Out (do not build)**
- Accounts, logins, profiles, ratings, history
- AI opponent
- Chat, emotes, friends lists
- Flying rule variant
- Spectator UI beyond a read-only board (see §6.4)
- Sound, animation polish beyond simple transitions

## 3. Stack

| Concern | Choice |
|---|---|
| Framework | Next.js (App Router), TypeScript, strict mode |
| Styling | Tailwind CSS |
| Board | Inline SVG (crisp at any size, easy hit targets) |
| Game engine | Pure TypeScript, zero dependencies, no React imports, fully unit-tested |
| State store | Adapter interface (§7.2). In-memory implementation for local dev and tests; Upstash Redis (Vercel Marketplace) in production |
| Sync | Client polling of a single `GET /api/game/[id]` endpoint (see §7.3). Realtime push is optional and only if it's trivially achievable without a separate host |
| Tests | Vitest (engine), Playwright (e2e, two browser contexts) |
| Hosting | Vercel. No long-lived server processes; everything must work as serverless/edge functions |

Rationale for polling over websockets: Vercel has no persistent socket host. A 1–2 s poll against Redis is invisible to a human in a turn-based game and needs zero extra infrastructure. Do not introduce PartyKit, Socket.io, or a second deployment target.

## 4. Rules (authoritative)

### 4.1 Board
- 24 points arranged as three concentric squares, connected at the midpoints of each side. 16 lines total. No diagonals.
- Points are indexed 0–23. Adjacency and the 16 mill lines are hard-coded tables in the engine, with a test that asserts every point has 2–4 neighbours and every point sits on exactly 2 lines.

Canonical indexing (outer ring 0–7, middle 8–15, inner 16–23, clockwise from top-left; midpoints are odd indices):

```
0-----------1-----------2
|           |           |
|   8-------9------10   |
|   |       |       |   |
|   |  16--17--18   |   |
|   |   |       |   |   |
7--15--23      19--11---3
|   |   |       |   |   |
|   |  22--21--20   |   |
|   |       |       |   |
|  14------13------12   |
|           |           |
6-----------5-----------4
```

### 4.2 Pieces and start
- Two players: **White** and **Black**. Nine pieces each, all starting in hand.
- White moves first. (Online: the game creator is White for game 1; colours swap on rematch.)

### 4.3 Phase 1 — Placement
- Players alternate placing one piece from hand onto any empty point.
- Phase ends when both hands are empty (18 placements, fewer if pieces are removed — hand count is what matters, not move count).

### 4.4 Phase 2 — Movement
- Players alternate sliding one of their pieces along a line to an adjacent empty point.
- No jumping. No flying at any piece count.

### 4.5 Mills and removal
- A mill is three of a player's pieces on one of the 16 lines.
- Forming a mill (by placing or moving) lets that player immediately remove **one** opponent piece. Forming two mills with one move still yields **one** removal.
- A piece that is part of an opponent's mill may only be removed if the opponent has no pieces outside a mill.
- Removal is a required sub-step of the same turn; the turn does not pass until it's done.
- Re-forming a mill by moving a piece out and back in counts as forming a mill again.

### 4.6 Win / loss / draw
A player **loses** when, at the start of their turn:
- they have fewer than 3 pieces (hand + board), or
- they are in the movement phase and have no legal move.

A player also loses by **forfeit** (timer, §5.3) or **resignation**.

**Draw**: 50 consecutive moves in the movement phase with no removal. Either player may also offer a draw; if the other accepts, draw.

## 5. Modes

### 5.1 Online (primary)
1. Visitor hits `/`, taps **New game**, picks a turn timer (§5.3). Server creates a room; client is issued a player token (stored in `localStorage`) and becomes White. Client lands on `/g/[roomId]`.
2. Share panel shows the link with **Copy** and, where available, Web Share API.
3. The first *other* visitor to `/g/[roomId]` claims Black and gets their own token. Any further visitors are read-only.
4. Play proceeds. Each client polls; the server is the only thing that mutates state and validates every move.
5. On game end: result banner, **Rematch** (§5.4), **New game** link.

Reconnection: tokens persist in `localStorage`, so refreshing or reopening the link on the same device resumes the seat. Losing the token means losing the seat (acceptable for v1).

### 5.2 Local hot-seat
- `/local`. Same engine, same board UI, no server, no polling. Status bar says whose turn it is. Rematch swaps colours. Timer optional.

### 5.3 Turn timer / forfeit
- Chosen at game creation: **None / 1 min / 5 min / 1 day**. Default 5 min.
- Clock is per turn (resets every move), server-authoritative via `turnStartedAt`.
- When the active player's clock runs out, the opponent's client shows **Claim win**. The server validates elapsed time before awarding the forfeit. No auto-forfeit without a claim (keeps it serverless-friendly and avoids surprise losses on a laggy reload).
- Client shows a countdown for both players; below 10 s it goes red.

### 5.4 Rematch
- Either player taps **Rematch**; the other sees **Accept rematch**. On accept, the room resets to a fresh game with colours swapped. Same URL, same tokens.

## 6. UX

### 6.1 Layout (mobile portrait first)
- Top: status bar — whose turn, phase, pending removal prompt, timers.
- Middle: board, square, fills width with 16 px margin, max 520 px.
- Bottom: hand counts (pieces in hand / on board per side), resign / offer-draw, share link.
- Desktop: same layout, centred, max-width 640 px. No separate desktop design.

### 6.2 Interaction
- **Placement**: tap an empty point. Legal points show a subtle hint on the player's turn.
- **Movement**: tap own piece to select (highlight + show legal destinations), tap destination. Tap elsewhere or same piece to deselect.
- **Removal**: board enters removal mode; removable opponent pieces pulse; non-removable ones (protected by a mill) are dimmed. Tap to remove.
- **Hit targets** ≥ 44 × 44 px at 360 px viewport width. Invisible larger tap circles around each point are fine.
- Not your turn: board is inert, status bar says "Waiting for Black…".
- Every illegal tap is silently ignored (no error toasts).

### 6.3 Feedback
- Last move highlighted (from/to points).
- Mill formed: the three pieces flash once.
- Game over: banner with result and reason (mill-out, blocked, forfeit, resignation, draw).
- Copy link: button text changes to "Copied" for 1.5 s.

### 6.4 Read-only visitors
- See the board and status, no controls, "Spectating" label. That's it.

### 6.5 Accessibility basics
- Board points are `<button>` elements with `aria-label` ("Point 12, empty" / "Point 12, White piece").
- Colour is never the only signal: pieces differ in fill **and** a subtle inner mark; selected/legal states use outline + shape.

## 7. Architecture

### 7.1 Engine (`/lib/engine`)
Pure functions over an immutable `GameState`. No side effects, no I/O.

```ts
type Player = 'W' | 'B';
type Cell = Player | null;
type Phase = 'placing' | 'moving' | 'over';

interface GameState {
  board: Cell[];              // length 24
  hand: { W: number; B: number };
  turn: Player;
  phase: Phase;
  pendingRemoval: boolean;     // true after a mill until removal done
  movesSinceRemoval: number;   // movement phase only, for the 50-move draw
  lastMove: { from: number | null; to: number } | null;
  result: null | { winner: Player | null; reason: 'millout' | 'blocked' | 'forfeit' | 'resign' | 'draw50' | 'drawagreed' };
}

type Action =
  | { type: 'place'; point: number }
  | { type: 'move'; from: number; to: number }
  | { type: 'remove'; point: number }
  | { type: 'resign' }
  | { type: 'forfeit'; player: Player };

function initialState(): GameState;
function legalActions(s: GameState): Action[];
function apply(s: GameState, a: Action, by: Player): GameState;   // throws on illegal
function formsMill(board: Cell[], point: number, p: Player): boolean;
function removablePieces(board: Cell[], opponent: Player): number[];
```

### 7.2 Store adapter (`/lib/store`)
```ts
interface RoomStore {
  get(id: string): Promise<Room | null>;
  set(id: string, room: Room): Promise<void>;
  // optimistic concurrency: reject if version doesn't match
  update(id: string, fn: (r: Room) => Room, expectedVersion: number): Promise<Room>;
}
```
- `MemoryStore` — process-local Map. Used in tests and when `REDIS_URL`/`KV_REST_API_URL` is absent.
- `RedisStore` — Upstash Redis via `@upstash/redis`. Keys `room:{id}`, TTL 7 days, refreshed on write.
- Room ids: 8-char, unambiguous alphabet (no 0/O/1/l), crypto-random.

### 7.3 API (`/app/api`)
- `POST /api/game` → `{ roomId, token }` (creates room, creator = White)
- `GET /api/game/[id]` → public room view + `version` (no tokens leaked)
- `POST /api/game/[id]/join` → `{ token, colour }` or 409 if full
- `POST /api/game/[id]/action` body `{ token, action, expectedVersion }` → new public view, or 409 on version mismatch, 403 on wrong turn/bad token
- `POST /api/game/[id]/claim-timeout` body `{ token }`
- `POST /api/game/[id]/rematch` body `{ token }` (offer/accept in one endpoint, idempotent)
- `POST /api/game/[id]/draw` body `{ token }` (offer/accept)

All mutation goes through `apply()` server-side. The client never trusts its own state; after any action it adopts the server response.

Polling: client polls `GET` every 1.5 s while the game is live and it is *not* the client's turn; every 5 s otherwise; stops when the tab is hidden (`visibilitychange`) and resumes on focus.

### 7.4 Room shape
```ts
interface Room {
  id: string;
  version: number;
  createdAt: number;
  players: { W: string | null; B: string | null };   // tokens — never returned to clients
  timerMs: number | null;
  turnStartedAt: number;
  game: GameState;
  rematch: { W: boolean; B: boolean };
  drawOffer: { W: boolean; B: boolean };
  gameNumber: number;   // increments on rematch; parity decides who is White
}
```

## 8. Quality bar (what "done" means)

1. **Engine**: 100% branch coverage on `/lib/engine`. Tests cover, at minimum: every adjacency and mill line; placement → movement transition on hand exhaustion (including when removals shorten it); single removal for double mill; protected-mill removal rule including the all-in-mills exception; blocked-loss detection; <3 pieces loss; 50-move draw counter reset on removal; illegal actions throw for every action type.
2. **Server**: every endpoint rejects wrong-token, wrong-turn, stale-version, and malformed bodies with the right status; timeout claim rejected before the clock expires and accepted after.
3. **E2E (Playwright)**: two browser contexts play a complete scripted game to a mill-out win through the real API using `MemoryStore`, then rematch and confirm colours swapped. A second e2e covers hot-seat to completion. A third covers timeout claim (timer set very low via a test-only env flag).
4. **Mobile**: e2e runs at 360×740 and 390×844; screenshots reviewed by the critic agent for overlap, cut-off text, and hit targets ≥ 44 px. No horizontal scroll.
5. **Deploy**: `npm run build` clean with zero type errors and zero lint warnings; `vercel build` succeeds if the CLI is present and linked (otherwise skipped, not failed); README documents the two env vars and the Vercel Marketplace Upstash step.
6. **Simplicity**: no dependency beyond Next, React, Tailwind, `@upstash/redis`, Vitest, Playwright, and Zod (for request validation). Anything else needs a one-line justification in the commit message.

## 9. Open decisions (already made, listed so nobody reopens them)
- No flying rule. Ever. If someone wants it, it's a v2 toggle.
- One removal per move, even on a double mill.
- Polling, not websockets.
- Player identity is a token in `localStorage`. Not a cookie, not an account.
- White always moves first; creator is White in game 1.
