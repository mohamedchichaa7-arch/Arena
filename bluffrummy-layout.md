# Bluff Rummy - Current UI Layout

## Desktop Layout (3-column)

```
+==================================================================================+
|                              FULL VIEWPORT (100vh)                               |
|                                                                                  |
| +----------+ +--------------------------------------------------+ +-----------+ |
| | SIDEBAR  | |                  MAIN CONTENT                    | | CHAT PANEL| |
| | 260px    | |                  (flex: 1)                       | | 220px     | |
| | #12122a  | |                  #0a0a1a                         | | #12122a   | |
| |          | |                                                  | |           | |
| |+---------+| | +----------------------------------------------+| |+---------+| |
| || PLAYERS || | |              GAME HEADER (row)                || ||  Chat   || |
| ||  header || | | [<- Lobby]  BLUFF RUMMY   Room #xxx           || ||  header || |
| |+---------+| | +----------------------------------------------+| |+---------+| |
| |           | |                                                  | |           | |
| |+--------+| | +-----+                                          | |+---------+| |
| || Player || | |Start |           "Connecting..."                | || msg 1   || |
| || card 1 || | |Game  |         (status text, gold)              | || msg 2   || |
| || * dot  || | +-----+                                          | || msg 3   || |
| || * name || | +-------------------------------------------------| || msg 4   || |
| || * count|| | |            TABLE AREA (max-w: 600px)           || || ...     || |
| |+--------+| | |                                                || ||         || |
| |+--------+| | | +--------------------------------------------+|| ||         || |
| || Player || | | |          PILE AREA (the "felt table")       ||| ||         || |
| || card 2 || | | |   radial-gradient green/dark bg             ||| ||         || |
| || active  | | | |   rounded corners, inset shadows            ||| ||         || |
| || = gold  | | | |                                             ||| ||         || |
| || border  | | | |   "MELD: Ks"  (pile label, Orbitron)        ||| ||         || |
| |+--------+| | | |                                             ||| ||         || |
| |+--------+| | | |     +--+ +--+ +--+ +--+ +--+  [x5]        ||| ||         || |
| || Player || | | |     |xx| |xx| |xx| |xx| |xx|              ||| ||         || |
| || card 3 || | | |     +--+ +--+ +--+ +--+ +--+              ||| ||         || |
| || elim.  || | | |     (face-down pile cards, purple,          ||| ||         || |
| || = dim  || | | |      overlapping, slightly rotated)         ||| ||         || |
| |+--------+| | | |                                    +------+ ||| ||         || |
| |           | | | |                                    |DISCARD|||| ||         || |
| |           | | | |                                    | DECK  |||| ||         || |
| |           | | | |                                    |+----+|||| ||         || |
| |           | | | |                                    ||card||||| ||         || |
| |           | | | |                                    ||stk ||||| ||         || |
| |           | | | |                                    |+----+|||| ||         || |
| |           | | | |                                    |DISCARDS|| ||         || |
| |           | | | |                                    | (3)   |||| ||         || |
| |           | | | |                                    +------+ ||| ||         || |
| |           | | | +--------------------------------------------+|| ||         || |
| |           | | |                                                || ||         || |
| |           | | | +--------------------------------------------+|| ||         || |
| |           | | | |          GAME FEED / ACTION LOG             ||| ||         || |
| |           | | | |  (max-h: 190px, scrollable)                ||| ||         || |
| |           | | | |                                             ||| ||         || |
| |           | | | |  Alice played 2 cards as "Kings"            ||| ||         || |
| |           | | | |  Bob challenges Alice!                      ||| ||         || |
| |           | | | |  Alice was honest -- Bob takes 2 cards      ||| ||         || |
| |           | | | |  Charlie joined the room                    ||| ||         || |
| |           | | | |                                             ||| ||         || |
| |           | | | |  (each entry: icon + text, colored left     ||| ||         || |
| |           | | | |   border by type: purple/red/green/gold)    ||| ||         || |
| |           | | | +--------------------------------------------+|| ||         || |
| |           | | +------------------------------------------------|| |+---------+| |
| |           | |                                                  | |+---------+| |
| |           | | +----------------------------------------------+| || [msg..] || |
| |           | | |            PLAY CONTROLS                      || || [send^] || |
| |           | | | "Select cards to play (1-3):"                 || |+---------+| |
| |           | | | Announce number: [dropdown]  [Play] [Challenge]|| |           | |
| |           | | +----------------------------------------------+| |           | |
| |           | |                                                  | |           | |
| |           | | +----------------------------------------------+| |           | |
| |           | | |         LAST PLAYED BAR (conditional)         || |           | |
| |           | | | "You played:" [card][card] claimed as "Kings" || |           | |
| |           | | +----------------------------------------------+| |           | |
| |           | |                                                  | |           | |
| |           | | +----------------------------------------------+| |           | |
| |           | | |             YOUR HAND (max-w: 700px)          || |           | |
| |           | | |           "YOUR HAND (5)" label               || |           | |
| |           | | |                                               || |           | |
| |           | | |  +----+ +----+ +----+ +----+ +----+          || |           | |
| |           | | |  | 3  | | 5  | | 7  | | J  | | K  |          || |           | |
| |           | | |  |    | |    | |    | |    | |    |          || |           | |
| |           | | |  +----+ +----+ +----+ +----+ +----+          || |           | |
| |           | | |  (white bg, 70x100px, hover lifts -6px,       || |           | |
| |           | | |   selected lifts -10px + purple glow)         || |           | |
| |           | | +----------------------------------------------+| |           | |
| +----------+ +--------------------------------------------------+ +-----------+ |
+==================================================================================+
```

## Card Design (current)

```
+----------+
|3         |    70px x 100px
|S         |    white background (#fff)
|          |    2px solid #ccc border
|    3     |    8px border-radius
|    S     |
|          |    Black suits (spade/club): #1a1a2e
|          |    Red suits (heart/diamond): #dc2626
+----------+
                Corner: num+suit (top-left, 0.45rem Orbitron)
                Center: num (1.2rem Orbitron 900) + suit (1.1rem)

Selected state:
  - translateY(-10px)
  - purple border + purple glow (0 0 15px)

Hover state:
  - translateY(-6px)
  - subtle purple shadow
```

## Face-Down Pile Card

```
+------+
| back |    44px x 62px
|      |    purple gradient bg (#4c1d95 -> #6d28d9)
+------+    purple border, purple shadow
            Cards overlap (margin-left: -18px)
            Each slightly rotated (-4deg to +4deg)
```

## Discard Deck (top-right of pile area)

```
  (3)  <-- count badge (green circle, absolute top-right)
+----+
|    | \
|    |  } 3 stacked cards, slightly rotated
|    | /    green gradient bg (#052e16 -> #15803d)
+----+      38x52px, green border
DISCARDS    <-- tiny Orbitron label

Hover reveals tooltip to the LEFT:
+------------------+
| DISCARDED SETS   |
|                  |
| x4  Alice -- Ks  |
| [K][K][K][K]     |
|                  |
| x4  Bob -- 7s    |
| [7][7][7][7]     |
+------------------+
  220px, dark green gradient bg
```

## Reveal Banner (slides from top)

```
                    +----------------------------------+
                    |        BLUFF CAUGHT!             |
                    |   (or "HONEST PLAY!")            |
                    |   gradient text (red+gold        |
                    |    or green+cyan)                |
                    |                                  |
                    |   +----+ +----+ +----+           |
                    |   | 5  | | 7  | | 5  |           |
                    |   | S  | | H  | | D  |           |
                    |   +----+ +----+ +----+           |
                    |   (green glow = honest,          |
                    |    red glow = bluff)              |
                    |                                  |
                    |   "Alice was right!              |
                    |    Bob takes 3 cards!"           |
                    |                                  |
                    |   [=======-----] countdown bar   |
                    +----------------------------------+

                    560px max, fixed top, auto-dismisses 4.5s
                    Dark gradient bg, purple border
                    Cards animate with rotateY flip
```

## Game Over Overlay

```
            +----------------------------+
            |                            |
            |    (full-screen dark bg)    |
            |                            |
            |      WINNER! (gold)        |
            |                            |
            |   +--------------------+   |
            |   | #1   Alice (You)   |   |
            |   +--------------------+   |
            |   | #2   Bob           |   |
            |   +--------------------+   |
            |   | #3   Charlie       |   |
            |   +--------------------+   |
            |   (gold / silver / bronze) |
            |                            |
            |      [Play Again]          |
            |                            |
            +----------------------------+

            + confetti canvas overlay if you won
```

## Challenge Flash

```
Full-screen red flash overlay (pointer-events: none)
Fades from rgba(239,68,68,.45) to transparent over 0.7s
Triggered when someone calls a challenge
```

## Mobile Layout (<768px)

```
+------------------------+
|  GAME HEADER           |
| [Players] BLUFF [Chat] |
|   btn      RUMMY  btn  |
+------------------------+
| [Start Game]           |
| "Your turn..."         |
+------------------------+
|     PILE AREA          |
|  (same as desktop)     |
|     + discard deck     |
+------------------------+
|     GAME FEED          |
+------------------------+
|     PLAY CONTROLS      |
| [dropdown] [Play]      |
|           [Challenge!] |
+------------------------+
|     YOUR HAND          |
| [card][card][card]...  |
| (56x80px, smaller)     |
+------------------------+

Sidebar: slides from LEFT (fixed, 80vw max 300px)
Chat:    slides from RIGHT (fixed, 80vw max 300px)
Both triggered by toggle buttons in header
Dark backdrop overlay when either is open
```

## Color Palette

```
Background:  #0a0a1a (near-black blue)
Surface:     #12122a (dark navy)
Card bg:     #1a1a3e (slightly lighter navy)
Border:      #2a2a5a (muted purple-grey)
Text:        #e0e0ff (soft white-blue)
Dim:         #7a7aaa (muted lavender)
Primary:     #8b5cf6 (purple)  -- buttons, glows, selection
Accent:      #06b6d4 (cyan)    -- player names, highlights
Gold:        #fbbf24            -- status text, winner, rank #1
Green:       #22c55e            -- honest plays, discards, your name
Red:         #ef4444            -- bluffs, challenges, eliminations
```

## Typography

```
Headers/Labels: Orbitron (weight 400/700/900) -- techy, all-caps, wide letter-spacing
Body text:      Inter (weight 300/400/600)    -- clean sans-serif
Font sizes:     Very small throughout (0.6-0.85rem for most UI)
```

## Animations Summary

| Animation      | What                                          | Duration |
|----------------|-----------------------------------------------|----------|
| dealIn         | Cards fly in from above when dealt             | 0.4s     |
| cardFlyUp      | Cards fade up when played                      | 0.5s     |
| ghostFly       | Purple ghost cards fly from hand to pile        | 0.55s    |
| discardFly     | Green ghost cards fly from pile to discard deck | 0.52s    |
| cardLand       | Pile cards drop in from above                  | 0.35s    |
| revealFlip     | Reveal cards do a Y-axis flip                  | 0.5s     |
| challengePulse | Challenge button pulses red glow               | 1.5s loop|
| cFlash         | Full-screen red flash on challenge              | 0.7s     |
| meldFlash      | Pile area border+shadow flash cyan              | 0.55s    |
| tableshake     | Pile area shakes horizontally                   | 0.4s     |
| feedSlide      | Feed entries slide in from left                 | 0.28s    |
| countPop       | Discard count badge pops in                     | 0.22s    |
| dtCardIn       | Tooltip cards flip in from below                | 0.3s     |
| dcardLand      | Discard stack cards scale in                    | 0.3s     |
