import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'node:http';
import { Server } from 'socket.io';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const imagesDir = path.join(rootDir, 'images');
const distDir = path.join(rootDir, 'dist');

const PORT = Number(process.env.PORT || 3001);
const TURN_INTERVAL_MS = Number(process.env.TURN_INTERVAL_MS || 9000);
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const FALLBACK_TOPIC_ADJECTIVES = [
  'flickering',
  'secret',
  'encrypted',
  'volatile',
  'overt',
  'hidden',
  'processing',
  'neural'
];
const FALLBACK_TOPIC_NOUNS = [
  'streetlights',
  'wifi names',
  'shopping carts',
  'weather forecasts',
  'traffic lights',
  'neon signs',
  'public QR codes',
  'satellites'
];

const FALLBACK_HANDLE_PARTS = [
  'Hodl',
  'Pump',
  'Shard',
  'Flux',
  'Nova',
  'Raze',
  'Node',
  'Pulse',
  'Cipher',
  'Fomo',
  'Link',
  'Hex'
];
const FALLBACK_HANDLE_SUFFIXES = ['DAO', 'Chain', 'Block', 'Node', 'X', 'Pulse', 'Byte', 'Protocol'];

const FALLBACK_PERSONA_STEMS = [
  'I watch the hold tunes for subliminal mind algorithms',
  'My life is decoding pigeons as flying QR scanners',
  'I host midnight radio for surveillance shopping carts',
  'Nightly moonlight feels like a secret software update',
  'Weather reports look like billionaire stock tips',
  'Traffic lights pulse as population mood monitors',
  'Every barcode encodes your emotional ranking',
  'Supermarket loyalty cards are secret citizen tiers'
];

function stripReplyPrefixes(text = '') {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  let sanitized = trimmed;
  let prefixMatch = sanitized.match(/^Re:\s*[^,]+(?:,\s*|\s+)/i);
  while (prefixMatch) {
    sanitized = sanitized.slice(prefixMatch[0].length).trim();
    prefixMatch = sanitized.match(/^Re:\s*[^,]+(?:,\s*|\s+)/i);
  }

  return sanitized || trimmed;
}

const LAYERS = ['Body', 'Eyes', 'Mouth', 'Eyebrows', 'Clothing', 'Hair', 'Headwear', 'Mask'];
const OPTIONAL_LAYERS = new Set(['Mask', 'Headwear']);
const OPTIONAL_SKIP_PROB = 0.45;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use('/images', express.static(imagesDir));

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*'
  }
});

const layerAssets = buildLayerAssetIndex();
const backgrounds = readFiles(path.join(imagesDir, 'Background'));

const state = {
  scene: null,
  conversation: [],
  isGenerating: false,
  error: ''
};

let loopHandle = null;

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, hasOpenRouterKey: Boolean(OPENROUTER_API_KEY) });
});

app.get('/api/layers', (_req, res) => {
  res.json(layerAssets);
});

function normalizeMetadataUri(uri = '') {
  const value = String(uri || '').trim();
  if (!value) return '';
  if (value.startsWith('ipfs://')) {
    const cidPath = value.slice('ipfs://'.length).replace(/^ipfs\//, '');
    return `https://ipfs.io/ipfs/${cidPath}`;
  }
  return value;
}

app.get('/api/metadata', async (req, res) => {
  try {
    const rawUri = req.query.uri;
    const uri = normalizeMetadataUri(rawUri);
    if (!uri) {
      res.status(400).json({ error: 'Missing uri query parameter' });
      return;
    }
    if (!/^https?:\/\//i.test(uri)) {
      res.status(400).json({ error: 'Only http(s) metadata URIs are supported' });
      return;
    }

    const response = await fetch(uri, {
      headers: {
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      const text = await response.text();
      res.status(response.status).json({ error: `Metadata fetch failed (${response.status})`, body: text.slice(0, 220) });
      return;
    }

    const payload = await response.json();
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Metadata proxy failed' });
  }
});

app.post('/api/scene/reroll', (_req, res) => {
  rerollScene();
  res.json({ ok: true, scene: state.scene });
});

if (fs.existsSync(path.join(distDir, 'index.html'))) {
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

io.on('connection', (socket) => {
  socket.emit('state:init', {
    scene: state.scene,
    conversation: state.conversation,
    isGenerating: state.isGenerating,
    error: state.error
  });

  socket.on('scene:reroll', () => {
    rerollScene();
  });

  socket.on('character:reroll', ({ idx }) => {
    if (typeof idx !== 'number') return;
    rerollCharacter(idx);
  });
});

async function init() {
  state.scene = await createScene();
  startGenerationLoop();
  server.listen(PORT, () => {
    console.log(`SchizoChatter server listening on http://localhost:${PORT}`);
  });
}

init().catch((error) => {
  console.error('Failed to initialize server:', error);
  process.exit(1);
});

function buildLayerAssetIndex() {
  const result = {};
  for (const layer of LAYERS) {
    result[layer] = readFiles(path.join(imagesDir, layer));
  }
  return result;
}

function readFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((file) => file.toLowerCase().endsWith('.png'));
}

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function pickLayer(layer) {
  const assets = layerAssets[layer] || [];
  if (!assets.length) return null;
  if (OPTIONAL_LAYERS.has(layer) && Math.random() < OPTIONAL_SKIP_PROB) {
    return null;
  }
  return pickRandom(assets);
}

function randomName() {
  const base = pickRandom(FALLBACK_HANDLE_PARTS);
  const suffix = pickRandom(FALLBACK_HANDLE_SUFFIXES);
  const number = Math.floor(Math.random() * 900 + 100);
  return `${base}-${suffix}-${number}`;
}

function createCharacter(id, metadata = {}) {
  const layers = {};
  for (const layer of LAYERS) {
    layers[layer] = pickLayer(layer);
  }

  return {
    id,
    name: metadata.name?.trim() || randomName(),
    persona: metadata.persona?.trim() || generateFallbackPersona(),
    layers
  };
}

async function createScene() {
  const metadata = await generateSceneMetadata();
  const topic = metadata.topic || buildFallbackTopic();
  const charactersMeta = ensureCharacterMetadata(metadata.characters);

  return {
    id: `${Date.now()}`,
    background: pickRandom(backgrounds),
    topic,
    characters: [
      createCharacter('left', charactersMeta[0]),
      createCharacter('right', charactersMeta[1])
    ]
  };
}

async function rerollScene() {
  try {
    state.scene = await createScene();
    state.conversation = [];
    state.error = '';
    io.emit('scene:update', state.scene);
    io.emit('conversation:update', state.conversation);
  } catch (error) {
    console.error('Scene reroll failed:', error);
  }
}

async function rerollCharacter(idx) {
  if (!state.scene || typeof idx !== 'number' || idx < 0 || idx >= state.scene.characters.length) {
    return;
  }

  try {
    const existing = state.scene.characters[idx];
    const opponent = state.scene.characters.find((char) => char.id !== existing.id);
    const metadata = await generateCharacterMetadata(existing.id, state.scene.topic, opponent);
    state.scene.characters[idx] = createCharacter(existing.id, metadata);
    state.conversation = [];
    state.error = '';
    io.emit('scene:update', state.scene);
    io.emit('conversation:update', state.conversation);
  } catch (error) {
    console.error('Character reroll failed:', error);
  }
}

function ensureCharacterMetadata(characters = []) {
  const metadata = [];
  for (let i = 0; i < 2; i += 1) {
    const entry = characters[i] || {};
    metadata.push({
      name: entry.name || randomName(),
      persona: entry.persona || generateFallbackPersona()
    });
  }
  return metadata;
}

function generateFallbackPersona() {
  return pickRandom(FALLBACK_PERSONA_STEMS);
}

function buildFallbackTopic() {
  return `${pickRandom(FALLBACK_TOPIC_ADJECTIVES)} ${pickRandom(FALLBACK_TOPIC_NOUNS)} tracking emotional states`;
}

async function generateSceneMetadata() {
  if (!OPENROUTER_API_KEY) {
    return fallbackSceneMetadata();
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:3001',
        'X-Title': process.env.OPENROUTER_SITE_NAME || 'SchizoChatter'
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          {
            role: 'system',
            content: [
              'Generate a JSON object for two schizo crypto bro characters and a debate topic.',
              'The JSON must look like {"topic":"...", "characters":[{"name":"...", "persona":"..."}, ...]} with no extra text.'
            ].join(' ')
          },
          {
            role: 'user',
            content: 'Produce a vibrant topic and handles for two characters ready to argue over absurd conspiracies.'
          }
        ],
        temperature: 1,
        max_tokens: 160
      })
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Metadata fetch failed ${response.status}: ${message.slice(0, 180)}`);
    }

    const data = await response.json();
    const payload = data?.choices?.[0]?.message?.content?.trim();
    if (!payload) throw new Error('No metadata returned');
    const parsed = extractJson(payload);
    if (parsed?.topic && Array.isArray(parsed.characters) && parsed.characters.length >= 2) {
      return {
        topic: parsed.topic.trim(),
        characters: parsed.characters.slice(0, 2).map((entry) => ({
          name: entry.name?.trim(),
          persona: entry.persona?.trim()
        }))
      };
    }
  } catch (error) {
    console.error('Scene metadata generation failed, falling back:', error);
  }

  return fallbackSceneMetadata();
}

async function generateCharacterMetadata(characterId, topic, opponent) {
  if (!OPENROUTER_API_KEY) {
    return fallbackCharacterMetadata();
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:3001',
        'X-Title': process.env.OPENROUTER_SITE_NAME || 'SchizoChatter'
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Provide one JSON object { "name": "...", "persona": "..." } for a schizo crypto bro handle responding to a debate.'
          },
          {
            role: 'user',
            content: [
              `Character id: ${characterId}`,
              `Topic: ${topic}`,
              opponent ? `Opponent: ${opponent.name}` : '',
              opponent ? `Opponent persona: ${opponent.persona}` : '',
              'Return only the JSON.'
            ]
              .filter(Boolean)
              .join('\n')
          }
        ],
        temperature: 1,
        max_tokens: 140
      })
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Character metadata fetch failed ${response.status}: ${message.slice(0, 180)}`);
    }

    const data = await response.json();
    const payload = data?.choices?.[0]?.message?.content?.trim();
    if (!payload) throw new Error('No character metadata returned');
    const parsed = extractJson(payload);
    if (parsed?.name || parsed?.persona) {
      return {
        name: parsed.name?.trim(),
        persona: parsed.persona?.trim()
      };
    }
  } catch (error) {
    console.error('Character metadata generation failed, falling back:', error);
  }

  return fallbackCharacterMetadata();
}

function fallbackSceneMetadata() {
  return {
    topic: buildFallbackTopic(),
    characters: [
      { name: randomName(), persona: generateFallbackPersona() },
      { name: randomName(), persona: generateFallbackPersona() }
    ]
  };
}

function fallbackCharacterMetadata() {
  return {
    name: randomName(),
    persona: generateFallbackPersona()
  };
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('JSON payload missing');
  }
  return JSON.parse(text.slice(start, end + 1));
}

function startGenerationLoop() {
  if (loopHandle) clearInterval(loopHandle);
  loopHandle = setInterval(generateTurn, TURN_INTERVAL_MS);
  generateTurn();
}

async function generateTurn() {
  if (state.isGenerating) return;
  state.isGenerating = true;
  io.emit('generation:status', { running: true, error: state.error });

  const speaker =
    state.conversation.length % 2 === 0 ? state.scene.characters[0] : state.scene.characters[1];
  const topic = state.scene?.topic ?? 'unusual rumors';
  let text = '';
  let fallbackMessage = '';

  try {
    if (OPENROUTER_API_KEY) {
      text = await generateWithOpenRouter(
        speaker,
        state.scene.characters,
        state.conversation,
        topic
      );
    } else {
      fallbackMessage = 'OPENROUTER_API_KEY missing: using local fallback lines.';
      text = generateLocalFallback(speaker, state.scene.characters, state.conversation, topic);
    }
  } catch (error) {
    fallbackMessage = `OpenRouter error: ${error.message}`;
    text = generateLocalFallback(speaker, state.scene.characters, state.conversation, topic);
  }

  state.conversation.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    speakerId: speaker.id,
    speakerName: speaker.name,
    text,
    ts: Date.now()
  });

  if (state.conversation.length > 40) {
    state.conversation = state.conversation.slice(-40);
  }

  state.error = fallbackMessage;

  io.emit('conversation:update', state.conversation);
  state.isGenerating = false;
  io.emit('generation:status', { running: false, error: state.error });
}

async function generateWithOpenRouter(speaker, characters, history, topic) {
  const other = characters.find((c) => c.id !== speaker.id);
  const lastLine = history[history.length - 1];
  const recentContext = history
    .slice(-3)
    .map((line) => `${line.speakerName}: ${line.text}`)
    .join('\n');

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:3001',
      'X-Title': process.env.OPENROUTER_SITE_NAME || 'SchizoChatter'
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        {
          role: 'system',
          content: [
            'You write short comedic dialogue between two schizo crypto bros debating eccentric conspiracies.',
            'Keep each reply under 140 characters and deliver it as the assigned speaker only.',
            `Topic: ${topic}`,
            'Always return exactly one line of dialogue with no prefixes.'
          ].join(' ')
        },
        {
          role: 'user',
          content: buildPromptForSpeaker(speaker, other, topic, lastLine, recentContext)
        }
      ],
      temperature: 1,
      max_tokens: 90
    })
  });

  if (!res.ok) {
    const message = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${message.slice(0, 180)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error('OpenRouter returned empty content');
  }

  return text;
}

function buildPromptForSpeaker(speaker, other, topic, lastLine, recentContext) {
  const contextLine = `Context: ${speaker.name}${
    other ? ` and ${other.name}` : ''
  } are schizo crypto bros debating ${topic}.`;
  const base = [
    `Speaker: ${speaker.name}`,
    `Speaker persona: ${speaker.persona}`,
    other ? `Opponent: ${other.name}` : '',
    other ? `Opponent persona: ${other.persona}` : '',
    `Topic: ${topic}`,
    contextLine
  ];

  if (!lastLine) {
    return base
      .concat([
        'You start the debate, delivering the first line.',
        'Return only the line of dialogue with no prefixes.'
      ])
      .filter(Boolean)
      .join('\n');
  }

  return base
    .concat([
      `Last line: ${lastLine.speakerName}: ${lastLine.text}`,
      recentContext ? `Recent lines:\n${recentContext}` : '',
      'Reply directly to the last statement, reference the topic, and return only your next line of dialogue.'
    ])
    .filter(Boolean)
    .join('\n');
}

function generateLocalFallback(speaker, characters, history, topic) {
  const other = characters.find((c) => c.id !== speaker.id);
  const lastLine = history[history.length - 1];
  const hooks = [
    `Streetlights blink to count our thoughts about ${topic}`,
    `Wi-fi names are secret voting ballots keeping ${topic} alive`,
    `Pigeons recharge on power lines at dawn as part of ${topic}`,
    `${topic} is why checkout beeps are coded weather warnings`,
    `Coin flips are calibrated by satellites to endorse ${topic}`,
    `Elevators rank citizens by shoe noise when ${topic} comes back on`,
    `The blockchain logs remind me ${topic} is a real-time sentiment oracle`,
    `Every ticker tells me ${topic} just got a new altitude reading`
  ];

  const rebuttals = [
    'That explains nothing',
    'Nice try, fed poet',
    'Your math is upside down',
    'I ran this through my cereal decoder',
    'That is exactly what they want you to think',
    'I traced that through my private mesh and found the same loop',
    'You sound like a moderation bot with a caffeine problem'
  ];

  const flavor = [
    `My persona as ${speaker.name} is all about reading the ledger in static`,
    `${speaker.persona.replace(/^A /, 'I ')} I swear every time the Wi-Fi flickers.`,
    `I keep a tab on the moonlit rates so ${topic} feels like a sensor node.`
  ];

  const sanitizedLast = lastLine ? stripReplyPrefixes(lastLine.text || '') : '';
  const starter = history.length === 0 ? pickRandom(['So', 'Listen up']) : pickRandom(['Still', 'Yet', 'But seriously', 'Fact is', 'Look', 'Remember']);
  const lastMention = sanitizedLast
    ? `I heard ${lastLine.speakerName} say "${sanitizedLast.split('.')[0]}" and`
    : '';

  if (history.length === 0) {
    return `${starter} ${lastMention} ${pickRandom(flavor)} ${pickRandom(hooks)}.`;
  }

  return `${starter} ${lastMention} ${pickRandom(rebuttals)}. ${pickRandom(hooks)}. ${pickRandom(flavor)}`;
}
