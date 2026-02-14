# SchizoChatter

Mobile-first PWA where two randomly generated layered characters argue in a globally synced chat.

## Features

- PWA installable app (mobile/tablet/desktop)
- Full background scene from `images/Background`
- Layered avatars with z-order:
  - Body
  - Eyes
  - Mouth
  - Eyebrows
  - Clothing
  - Hair
  - Headwear
  - Mask
- Left avatar mirrored so it faces inward
- Real-time shared state via Socket.IO (same scene + same chat for all connected users)
- OpenRouter integration for line generation
- Fallback local generator if no OpenRouter key is set

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create env file:

```bash
cp .env.example .env
```

3. Add your key in `.env`:

```env
OPENROUTER_API_KEY=your_key_here
```

4. Run dev mode (server + client):

```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- API/Socket server: `http://localhost:3001`

## Production

```bash
npm run build
npm run start
```

The server hosts built frontend from `dist/`.

## Notes

- `Overlays` and `Sidekick` assets are intentionally not rendered yet.
- Use "New Debate" in the UI to reroll both characters and the background for everyone.
