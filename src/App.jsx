import { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';

const LAYER_ORDER = ['Body', 'Mask', 'Eyes', 'Eyebrows', 'Hair', 'Clothing', 'Headwear', 'Mouth'];
const STAGE_CHARACTERS = [
  { idx: 1, mirror: false },
  { idx: 0, mirror: true }
];
const MAX_CHAT_LINES = 30;
const socketHost = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const socket = io(socketHost, { transports: ['websocket', 'polling'] });

const stripReplyPrefixes = (text = '') => {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  let sanitized = trimmed;
  let prefixMatch = sanitized.match(/^Re:\s*[^,]+(?:,\s*|\s+)/i);
  while (prefixMatch) {
    sanitized = sanitized.slice(prefixMatch[0].length).trim();
    prefixMatch = sanitized.match(/^Re:\s*[^,]+(?:,\s*|\s+)/i);
  }

  return sanitized || trimmed;
};

const escapeForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const stripSpeakerPrefix = (text = '', name = '') => {
  if (!name) return text.trim();
  const escapedName = escapeForRegex(name);
  const regex = new RegExp(`^${escapedName}:\\s*`, 'i');
  let sanitized = text.trim();
  let last;
  do {
    last = sanitized;
    sanitized = sanitized.replace(regex, '').trim();
  } while (sanitized !== last);
  return sanitized;
};

const removeKnownNamePrefix = (text = '', names = []) => {
  const candidates = (names || [])
    .map((name) => name?.trim())
    .filter(Boolean)
    .map((name) => name.replace(/\s+/g, ' '));

  if (!candidates.length) return text.trim();
  const regex = new RegExp(`^(${candidates.map(escapeForRegex).join('|')}):\\s*`, 'i');
  let sanitized = text.trim();
  let previous;
  do {
    previous = sanitized;
    sanitized = sanitized.replace(regex, '').trim();
  } while (sanitized !== previous && sanitized.length);
  return sanitized;
};

function CharacterStage({ character, mirror = false, onReroll }) {
  if (!character) return null;

  return (
    <div className={`character-stage ${mirror ? 'mirrored' : ''}`}>
      <div className="character-frame">
        <div className="character-name">{character.name}</div>
        <div className="mini-hint">New persona uploaded</div>
        <button className="btn-refresh" onClick={onReroll}>
          Refresh
        </button>
      </div>
      <div className="character-wrap">
        <div className="avatar">
          {LAYER_ORDER.map((layer) => {
            const fileName = character.layers?.[layer];
            if (!fileName) return null;
            const cssLayerName = layer.replace(/\s+/g, '-').toLowerCase();
            return (
              <img
                key={layer}
                className={`avatar-layer layer-${cssLayerName}`}
                src={`/images/${layer}/${encodeURIComponent(fileName)}`}
                alt={`${character.name} ${layer}`}
                loading="eager"
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [scene, setScene] = useState(null);
  const [conversation, setConversation] = useState([]);
  const [connected, setConnected] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('state:init', (payload) => {
      setScene(payload.scene);
      setConversation(payload.conversation || []);
      setIsGenerating(Boolean(payload.isGenerating));
      setError(payload.error || '');
    });
    socket.on('scene:update', (payload) => setScene(payload));
    socket.on('conversation:update', (payload) => {
      setConversation(payload || []);
      setError('');
    });
    socket.on('generation:status', (payload) => {
      setIsGenerating(Boolean(payload?.running));
      setError(payload?.error || '');
    });

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('state:init');
      socket.off('scene:update');
      socket.off('conversation:update');
      socket.off('generation:status');
    };
  }, []);

    const sanitizedConversation = useMemo(() => {
      const knownNames = scene?.characters?.map((char) => char.name).filter(Boolean);
      return conversation.map((line) => {
        const baseText = stripReplyPrefixes(line.text || '');
        const withoutSpeaker = stripSpeakerPrefix(baseText, line.speakerName);
        const sanitizedText = removeKnownNamePrefix(withoutSpeaker, knownNames);
        const normalizedText = sanitizedText || baseText.trim() || '';
        const character = scene?.characters?.find((char) => char.id === line.speakerId);
        const displayName = character?.name || line.speakerName || 'Unknown';
        const charIndex = scene?.characters?.findIndex((char) => char.id === line.speakerId);
        const isLeftBubble = charIndex === 1;
        return {
          ...line,
          sanitizedText: normalizedText,
          displayName,
          bubbleLeft: isLeftBubble
        };
      });
    }, [conversation, scene]);

  const formattedConversation = useMemo(() => {
    const recent = sanitizedConversation.slice(-MAX_CHAT_LINES);
    const collapsed = [];
    for (const line of recent) {
      const previous = collapsed[collapsed.length - 1];
      if (previous && previous.speakerId === line.speakerId && previous.sanitizedText === line.sanitizedText) {
        previous.repeat = (previous.repeat ?? 1) + 1;
        continue;
      }
      collapsed.push({ ...line, repeat: 1 });
    }
    return collapsed;
  }, [sanitizedConversation]);

  const showError = Boolean(error && conversation.length === 0);

  const bgStyle = scene?.background
    ? {
        backgroundImage: `linear-gradient(180deg, rgba(2, 2, 2, 0.8), rgba(5, 5, 8, 0.95)), url(/images/Background/${encodeURIComponent(
          scene.background
        )})`
      }
    : undefined;

  const rerollSingle = (idx) => {
    socket.emit('character:reroll', { idx });
  };

  const debugTopic = scene?.topic ? scene.topic.toUpperCase() : 'TUNE IN...';

  return (
    <main className="schizo-app" style={bgStyle}>
      <div className="app-overlay" />
      <div className="grain-overlay" />
      <div className="scene-grid">
        <CharacterStage
          key="left"
          character={scene?.characters?.[1]}
          mirror={false}
          onReroll={() => rerollSingle(1)}
        />
        <section className="chat-column">
          <div className="chat-card">
            <div className="card-top">
              <div>
                <p className="chat-label">Conspiracy Feed</p>
                <p className="chat-topic">{debugTopic}</p>
              </div>
              <span className={`status-pill ${connected ? 'live' : 'offline'}`}>
                {connected ? 'Live Synced' : 'Reconnecting'}
              </span>
            </div>
              <div className="chat-stream">
                {formattedConversation.map((line) => (
                  <article
                    key={`${line.id}-${line.repeat}`}
                    className={`chat-line bubble ${line.bubbleLeft ? 'bubble-left' : 'bubble-right'}`}
                  >
                    <span className="line-name">{line.displayName}</span>
                    <div className="bubble-inner">{line.sanitizedText}</div>
                    {line.repeat > 1 && <span className="line-repeat">repeated {line.repeat}x</span>}
                  </article>
                ))}
              </div>
            {showError && <p className="error">{error}</p>}
            <div className="chat-foot">
              <button className="btn debate" onClick={() => socket.emit('scene:reroll')}>
                New Debate
              </button>
              <span className="generation-status">{isGenerating ? 'Generating…' : 'Waiting'}</span>
            </div>
          </div>
        </section>
        <CharacterStage
          key="right"
          character={scene?.characters?.[0]}
          mirror={true}
          onReroll={() => rerollSingle(0)}
        />
      </div>
    </main>
  );
}
