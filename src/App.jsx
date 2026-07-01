import { useCallback, useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

const LAYER_ORDER = ['Body', 'Mask', 'Eyes', 'Eyebrows', 'Hair', 'Clothing', 'Headwear', 'Mouth'];
const MAX_CHAT_LINES = 30;
const TARGET_COLLECTION = 'EZDyWTdLNpZfuAsTnGFuHnCyBSmXrewaioFh5XZvsLdr';
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const METADATA_SEED = new TextEncoder().encode('metadata');
const HELIUS_ENDPOINT = import.meta.env.VITE_HELIUS_RPC_URL || (import.meta.env.VITE_HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${import.meta.env.VITE_HELIUS_API_KEY}`
  : '');
const FALLBACK_RPC_ENDPOINTS = [
  HELIUS_ENDPOINT,
  import.meta.env.VITE_SOLANA_RPC_URL,
  clusterApiUrl('mainnet-beta'),
  'https://solana-mainnet.g.alchemy.com/v2/demo'
].filter(Boolean);
const socketHost = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const socket = io(socketHost, { transports: ['websocket', 'polling'] });

const LAYER_TRAIT_LOOKUP = {
  body: 'Body',
  eyes: 'Eyes',
  eyebrows: 'Eyebrows',
  mouth: 'Mouth',
  hair: 'Hair',
  clothing: 'Clothing',
  headwear: 'Headwear',
  hat: 'Headwear',
  mask: 'Mask'
};

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

const normalizeTraitType = (traitType = '') => traitType.toLowerCase().replace(/[^a-z]/g, '');

const getFileCandidates = (value = '') => {
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  const tail = decodeURIComponent(trimmed.split('/').pop() || '').trim();
  if (!tail) return [];
  const noExt = tail.replace(/\.png$/i, '').trim();
  if (!noExt) return [];
  const candidates = [
    `${noExt}.png`,
    `${noExt.replace(/\s+/g, '_')}.png`,
    `${noExt.replace(/\s+/g, '-')}.png`,
    `${noExt.toLowerCase()}.png`,
    `${noExt.toLowerCase().replace(/\s+/g, '_')}.png`,
    `${noExt.toLowerCase().replace(/\s+/g, '-')}.png`
  ];
  if (/\.png$/i.test(tail)) candidates.unshift(tail);
  return [...new Set(candidates)];
};

const resolveLayerFile = (layerName, traitValue, layerIndex) => {
  const files = layerIndex?.[layerName] || [];
  if (!files.length) {
    return { fileName: null, candidates: getFileCandidates(traitValue), matched: false, reason: 'No local files for layer' };
  }

  const lowerLookup = new Map(files.map((file) => [file.toLowerCase(), file]));
  const candidates = getFileCandidates(traitValue);
  for (const candidate of candidates) {
    const hit = lowerLookup.get(candidate.toLowerCase());
    if (hit) return { fileName: hit, candidates, matched: true, reason: '' };
  }

  return { fileName: null, candidates, matched: false, reason: 'No filename match in local layer folder' };
};

const attributesToLayers = (attributes = [], layerIndex = {}) => {
  const layers = {};
  const debug = [];

  for (const attribute of attributes) {
    const traitType = String(attribute?.trait_type || '');
    const traitValue = String(attribute?.value ?? '');
    const key = normalizeTraitType(traitType);
    const layerName = LAYER_TRAIT_LOOKUP[key];
    if (!layerName) {
      debug.push({
        traitType,
        traitValue,
        layerName: null,
        fileName: null,
        matched: false,
        reason: 'Trait type not mapped to a character layer',
        candidates: []
      });
      continue;
    }

    const resolved = resolveLayerFile(layerName, traitValue, layerIndex);
    if (resolved.fileName) layers[layerName] = resolved.fileName;
    debug.push({
      traitType,
      traitValue,
      layerName,
      fileName: resolved.fileName,
      matched: resolved.matched,
      reason: resolved.reason,
      candidates: resolved.candidates
    });
  }

  return { layers, debug };
};

const loadJsonMetadata = async (uri) => {
  if (!uri) return null;
  try {
    const response = await fetch(`${socketHost}/api/metadata?uri=${encodeURIComponent(uri)}`);
    if (!response.ok) return null;
    return await response.json();
  } catch (_error) {
    return null;
  }
};

const readU8 = (data, offset) => [data[offset], offset + 1];
const readU16 = (data, offset) => [data[offset] | (data[offset + 1] << 8), offset + 2];
const readU32 = (data, offset) => [
  data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24),
  offset + 4
];

const readString = (data, offset) => {
  const [len, next] = readU32(data, offset);
  const end = next + len;
  if (end > data.length) return ['', data.length];
  const value = new TextDecoder().decode(data.slice(next, end)).replace(/\0/g, '').trim();
  return [value, end];
};

const readOptionFlag = (data, offset) => {
  const [flag, next] = readU8(data, offset);
  return [flag === 1, next];
};

const skipCreators = (data, offset) => {
  const [hasCreators, start] = readOptionFlag(data, offset);
  if (!hasCreators) return start;
  const [count, next] = readU32(data, start);
  return Math.min(next + count * 34, data.length);
};

const skipOptionU8 = (data, offset) => {
  const [present, start] = readOptionFlag(data, offset);
  return present ? Math.min(start + 1, data.length) : start;
};

const skipUses = (data, offset) => {
  const [present, start] = readOptionFlag(data, offset);
  return present ? Math.min(start + 17, data.length) : start;
};

const parseMetadataAccount = (accountData) => {
  const data = new Uint8Array(accountData);
  if (data.length < 70) return null;

  let offset = 0;
  [, offset] = readU8(data, offset); // key
  offset += 32; // update authority
  offset += 32; // mint

  const [name, afterName] = readString(data, offset);
  const [symbol, afterSymbol] = readString(data, afterName);
  const [uri, afterUri] = readString(data, afterSymbol);
  [, offset] = readU16(data, afterUri); // seller fee
  offset = skipCreators(data, offset);
  [, offset] = readU8(data, offset); // primary sale happened
  [, offset] = readU8(data, offset); // is mutable
  offset = skipOptionU8(data, offset); // edition nonce
  offset = skipOptionU8(data, offset); // token standard

  const [hasCollection, afterCollectionFlag] = readOptionFlag(data, offset);
  let collection = null;
  offset = afterCollectionFlag;
  if (hasCollection && offset + 33 <= data.length) {
    const [verified, afterVerified] = readU8(data, offset);
    const key = new PublicKey(data.slice(afterVerified, afterVerified + 32)).toBase58();
    collection = { verified: verified === 1, key };
    offset = afterVerified + 32;
  }

  offset = skipUses(data, offset);

  return {
    name,
    symbol,
    uri,
    collection
  };
};

const summarizeAttributes = (attributes = []) => {
  const compact = attributes
    .filter((item) => item?.trait_type && item?.value)
    .slice(0, 4)
    .map((item) => `${item.trait_type}: ${item.value}`);
  return compact.length ? compact.join(' | ') : 'Wallet trait profile';
};

const errorLooksForbidden = (error) => {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('403') || message.includes('access forbidden') || message.includes('forbidden');
};

const withRpcFallback = async (rpcTask) => {
  let lastError = null;
  for (const endpoint of FALLBACK_RPC_ENDPOINTS) {
    try {
      const conn = new Connection(endpoint, 'confirmed');
      return await rpcTask(conn);
    } catch (error) {
      lastError = error;
      if (!errorLooksForbidden(error)) {
        throw error;
      }
    }
  }
  throw lastError || new Error('No RPC endpoint available');
};

function CharacterStage({ character, mirror = false, onReroll }) {
  if (!character) return null;
  const hasAnyLayer = LAYER_ORDER.some((layer) => Boolean(character.layers?.[layer]));

  return (
    <div className={`character-stage ${mirror ? 'mirrored' : ''}`}>
      <div className="character-frame">
        <div className="character-name">{character.name}</div>
        <div className="mini-hint">{character.persona || 'New persona uploaded'}</div>
        <button className="btn-refresh" onClick={onReroll}>
          Refresh
        </button>
      </div>
      <div className="character-wrap">
        <div className="avatar">
          {!hasAnyLayer && <div className="avatar-layer-missing">No local trait layers matched</div>}
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
  const [walletCharacters, setWalletCharacters] = useState([]);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState('');
  const [assigned, setAssigned] = useState({ left: null, right: null });
  const [layerIndex, setLayerIndex] = useState({});

  const { publicKey, connected: walletConnected } = useWallet();

  const scanWalletCollection = useCallback(async () => {
    if (!publicKey) return;
    setWalletLoading(true);
    setWalletError('');

    try {
      const tokenAccounts = await withRpcFallback((rpc) =>
        Promise.all([
          rpc.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID }),
          rpc.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM_ID })
        ])
      );

      const mintSet = new Set();
      for (const group of tokenAccounts) {
        for (const account of group.value) {
          const tokenAmount = account.account.data.parsed?.info?.tokenAmount;
          if (!tokenAmount) continue;
          const amount = Number(tokenAmount.amount || '0');
          const decimals = Number(tokenAmount.decimals || 0);
          if (amount <= 0 || decimals !== 0) continue;
          const mint = account.account.data.parsed?.info?.mint;
          if (mint) mintSet.add(mint);
        }
      }

      const mints = [...mintSet].map((mint) => new PublicKey(mint));
      const metadataAddresses = mints.map((mint) =>
        PublicKey.findProgramAddressSync(
          [METADATA_SEED, METADATA_PROGRAM_ID.toBytes(), mint.toBytes()],
          METADATA_PROGRAM_ID
        )[0]
      );

      const metadataAccounts = await withRpcFallback((rpc) => rpc.getMultipleAccountsInfo(metadataAddresses));
      const matched = [];

      for (let i = 0; i < metadataAccounts.length; i += 1) {
        const accountInfo = metadataAccounts[i];
        if (!accountInfo?.data) continue;
        const metadata = parseMetadataAccount(accountInfo.data);
        if (!metadata?.collection) continue;
        if (!metadata.collection.verified) continue;
        if (metadata.collection.key !== TARGET_COLLECTION) continue;
        matched.push({
          mint: mints[i].toBase58(),
          name: metadata.name || mints[i].toBase58(),
          uri: metadata.uri || ''
        });
      }

      const parsed = await Promise.all(
        matched.map(async (item) => {
          const json = await loadJsonMetadata(item.uri);
          const attributes = Array.isArray(json?.attributes) ? json.attributes : [];
          const { layers, debug } = attributesToLayers(attributes, layerIndex);
          const name = (json?.name || item.name || item.mint).trim();
          const matchedCount = debug.filter((entry) => entry.matched).length;
          const mappedCount = debug.filter((entry) => entry.layerName).length;
          const metadataOk = Boolean(json);

          return {
            mint: item.mint,
            name,
            attributes,
            debug,
            matchedCount,
            mappedCount,
            metadataOk,
            metadataUri: item.uri,
            persona: summarizeAttributes(attributes),
            character: {
              id: `wallet-${item.mint}`,
              name,
              persona: summarizeAttributes(attributes),
              layers
            }
          };
        })
      );

      setWalletCharacters(parsed);
      if (!parsed.length) {
        setWalletError('No NFTs from the target collection were found in this wallet.');
      }
    } catch (scanError) {
      if (errorLooksForbidden(scanError)) {
        setWalletError('RPC access forbidden. Set VITE_SOLANA_RPC_URL to a mainnet endpoint that allows this origin.');
      } else {
        setWalletError(scanError?.message || 'Failed to scan wallet collection.');
      }
      setWalletCharacters([]);
    } finally {
      setWalletLoading(false);
    }
  }, [layerIndex, publicKey]);

  useEffect(() => {
    const loadLayerIndex = async () => {
      try {
        const response = await fetch(`${socketHost}/api/layers`);
        if (!response.ok) return;
        const payload = await response.json();
        setLayerIndex(payload || {});
      } catch (_error) {
        setLayerIndex({});
      }
    };
    loadLayerIndex();
  }, []);

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

  useEffect(() => {
    if (!publicKey) {
      setWalletCharacters([]);
      setAssigned({ left: null, right: null });
      setWalletError('');
      return;
    }
    scanWalletCollection();
  }, [publicKey, scanWalletCollection]);

  const sanitizedConversation = useMemo(() => {
    const knownNames = scene?.characters?.map((char) => char.name).filter(Boolean);

    return conversation.map((line) => {
      const baseText = stripReplyPrefixes(line.text || '');
      const withoutSpeaker = stripSpeakerPrefix(baseText, line.speakerName);
      const sanitizedText = removeKnownNamePrefix(withoutSpeaker, knownNames);
      const normalizedText = sanitizedText || baseText.trim() || '';
      const charIndex = scene?.characters?.findIndex((char) => char.id === line.speakerId);

      let displayName = line.speakerName || 'Unknown';
      if (charIndex === 0 && assigned.right?.character?.name) displayName = assigned.right.character.name;
      if (charIndex === 1 && assigned.left?.character?.name) displayName = assigned.left.character.name;
      if (charIndex !== 0 && charIndex !== 1) {
        const fallbackCharacter = scene?.characters?.find((char) => char.id === line.speakerId);
        if (fallbackCharacter?.name) displayName = fallbackCharacter.name;
      }

      return {
        ...line,
        sanitizedText: normalizedText,
        displayName,
        bubbleLeft: charIndex === 1
      };
    });
  }, [assigned.left, assigned.right, conversation, scene]);

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
  const leftCharacter = assigned.left?.character || scene?.characters?.[1];
  const rightCharacter = assigned.right?.character || scene?.characters?.[0];

  return (
    <main className="schizo-app" style={bgStyle}>
      <div className="app-overlay" />
      <div className="grain-overlay" />
      <div className="scene-grid">
        <CharacterStage key="left" character={leftCharacter} mirror={false} onReroll={() => rerollSingle(1)} />
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

            <div className="wallet-panel">
              <div className="wallet-row">
                <WalletMultiButton />
                {walletConnected && (
                  <button className="btn-refresh" onClick={scanWalletCollection} disabled={walletLoading}>
                    {walletLoading ? 'Scanning...' : 'Rescan Collection'}
                  </button>
                )}
              </div>
              {walletConnected && (
                <p className="wallet-summary">
                  {walletLoading ? 'Scanning wallet...' : `${walletCharacters.length} token(s) found in collection`}
                </p>
              )}
              {walletError && <p className="wallet-error">{walletError}</p>}
              {walletCharacters.length > 0 && (
                <div className="wallet-token-list">
                  {walletCharacters.map((token) => {
                    const isLeft = assigned.left?.mint === token.mint;
                    const isRight = assigned.right?.mint === token.mint;
                    return (
                      <article className="wallet-token" key={token.mint}>
                        <div className="wallet-token-main">
                          <div className="wallet-thumb empty">{token.matchedCount}/{token.mappedCount}</div>
                          <div className="wallet-token-copy">
                            <p className="wallet-token-name">{token.name}</p>
                            <p className="wallet-token-mint">{token.mint}</p>
                            {!token.metadataOk && <p className="wallet-token-meta-error">Metadata fetch failed</p>}
                          </div>
                        </div>
                        <div className="wallet-debug-lines">
                          {token.debug
                            .filter((entry) => entry.layerName)
                            .slice(0, 6)
                            .map((entry, idx) => (
                              <p className={`wallet-debug-line ${entry.matched ? 'ok' : 'miss'}`} key={`${token.mint}-${idx}`}>
                                {entry.traitType}: {entry.traitValue} {'->'} {entry.layerName} {'->'} {entry.fileName || 'NO MATCH'}
                              </p>
                            ))}
                        </div>
                        <div className="wallet-token-actions">
                          <button
                            className={`wallet-side-btn ${isLeft ? 'active' : ''}`}
                            onClick={() => setAssigned((prev) => ({ ...prev, left: token }))}
                          >
                            Left
                          </button>
                          <button
                            className={`wallet-side-btn ${isRight ? 'active' : ''}`}
                            onClick={() => setAssigned((prev) => ({ ...prev, right: token }))}
                          >
                            Right
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
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
        <CharacterStage key="right" character={rightCharacter} mirror={true} onReroll={() => rerollSingle(0)} />
      </div>
    </main>
  );
}
