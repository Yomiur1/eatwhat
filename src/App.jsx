import { useState, useEffect, useRef, useCallback } from 'react';
import {
  ref, set, get, onValue, update, remove, serverTimestamp,
} from 'firebase/database';
import { signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { db, auth } from './firebase';

// ─────────────────────────────────────────────────────────────────
// Theme
// ─────────────────────────────────────────────────────────────────
const T = {
  primary: '#FF6B35', primaryD: '#D9521F',
  accent: '#FFB703',  accentD: '#E09E00',
  bg: '#FFFAF4', card: '#FFFFFF',
  dark: '#2A1600', gray: '#8C7355',
  border: '#EFD9C2', lightBg: '#FFF3E4',
  green: '#40916C', greenLight: '#D8F3DC',
  red: '#E63946',
};

// ─────────────────────────────────────────────────────────────────
// Google Maps loader (singleton promise)
// ─────────────────────────────────────────────────────────────────
let _mapsPromise = null;
const loadMaps = () => {
  if (_mapsPromise) return _mapsPromise;
  _mapsPromise = new Promise((resolve, reject) => {
    if (window.google?.maps) { resolve(); return; }
    window.__mapsCallback = resolve;
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${import.meta.env.VITE_GOOGLE_MAPS_API_KEY}&libraries=places&callback=__mapsCallback&language=zh-TW&region=TW`;
    s.onerror = () => reject(new Error('Google Maps 載入失敗'));
    document.head.appendChild(s);
  });
  return _mapsPromise;
};

// ─────────────────────────────────────────────────────────────────
// Geo utilities
// ─────────────────────────────────────────────────────────────────
const haversine = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const centerOf = (coords) => ({
  lat: coords.reduce((s, c) => s + c.lat, 0) / coords.length,
  lng: coords.reduce((s, c) => s + c.lng, 0) / coords.length,
});

const genCode = () => {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

// Budget NT$ → Google price_level (0–4)
const budgetToLevel = (b) => b < 150 ? 1 : b < 300 ? 2 : b < 600 ? 3 : 4;

// ─────────────────────────────────────────────────────────────────
// Google Places search (real API)
// ─────────────────────────────────────────────────────────────────
const searchRestaurants = (center, radiusKm, maxBudget) =>
  new Promise((resolve) => {
    // Needs a real (visible) div for PlacesService
    const div = document.createElement('div');
    div.style.cssText = 'width:1px;height:1px;position:fixed;opacity:0;top:0;left:0;';
    document.body.appendChild(div);
    const map = new window.google.maps.Map(div, { center, zoom: 15 });
    const svc = new window.google.maps.places.PlacesService(map);
    const maxLevel = budgetToLevel(maxBudget);

    svc.nearbySearch(
      { location: center, radius: Math.min(radiusKm * 1000, 50000), type: 'restaurant' },
      (results, status) => {
        document.body.removeChild(div);
        if (status !== 'OK' || !results) { resolve([]); return; }

        const restaurants = results
          .filter(r => r.business_status === 'OPERATIONAL')
          .filter(r => (r.price_level ?? 2) <= maxLevel)
          .slice(0, 16)
          .map(r => ({
            id: r.place_id,
            name: r.name,
            address: r.vicinity,
            rating: r.rating ?? 0,
            reviews: r.user_ratings_total ?? 0,
            priceLevel: r.price_level ?? 2,
            lat: r.geometry.location.lat(),
            lng: r.geometry.location.lng(),
            photo: r.photos?.[0]?.getUrl({ maxWidth: 400 }) ?? null,
            mapsUrl: `https://www.google.com/maps/place/?q=place_id:${r.place_id}`,
          }));
        resolve(restaurants);
      },
    );
  });

// ─────────────────────────────────────────────────────────────────
// Base UI components
// ─────────────────────────────────────────────────────────────────
const Btn = ({ children, onClick, variant = 'primary', disabled = false, sx = {} }) => {
  const V = {
    primary: { background: `linear-gradient(160deg,${T.primary},${T.primaryD})`, color: '#fff', border: 'none', boxShadow: `0 4px 14px ${T.primary}50` },
    accent:  { background: `linear-gradient(160deg,${T.accent},${T.accentD})`,   color: '#fff', border: 'none', boxShadow: `0 4px 14px ${T.accent}60` },
    outline: { background: 'transparent', color: T.primary, border: `2px solid ${T.primary}` },
    ghost:   { background: T.lightBg,     color: T.gray,   border: `1.5px solid ${T.border}` },
    green:   { background: `linear-gradient(160deg,${T.green},#2D6A4F)`, color: '#fff', border: 'none', boxShadow: `0 4px 14px ${T.green}50` },
    danger:  { background: `linear-gradient(160deg,${T.red},#B51B26)`,   color: '#fff', border: 'none' },
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{
      ...V[variant],
      padding: '14px 24px', borderRadius: 16, fontWeight: 800, fontSize: '0.97rem',
      fontFamily: "'Noto Sans TC',sans-serif", cursor: disabled ? 'not-allowed' : 'pointer',
      width: '100%', opacity: disabled ? 0.45 : 1, transition: 'all 0.18s', ...sx,
    }}>{children}</button>
  );
};

const Card = ({ children, sx = {}, onClick }) => (
  <div onClick={onClick} style={{
    background: T.card, borderRadius: 22, padding: 20,
    boxShadow: '0 6px 28px rgba(255,107,53,0.07)', border: `1px solid ${T.border}`,
    cursor: onClick ? 'pointer' : 'default', ...sx,
  }}>{children}</div>
);

const Tag = ({ children, color = T.primary }) => (
  <span style={{
    background: `${color}18`, color, borderRadius: 20, padding: '3px 12px',
    fontSize: '0.72rem', fontWeight: 700, display: 'inline-block', margin: '2px 3px 2px 0',
  }}>{children}</span>
);

const Stars = ({ r = 0 }) => (
  <span style={{ color: T.accent, fontSize: '0.85rem' }}>
    {'★'.repeat(Math.floor(r))}{r % 1 >= 0.5 ? '☆' : ''}
    <span style={{ color: T.gray, marginLeft: 3 }}>{r.toFixed(1)}</span>
  </span>
);

const PriceTag = ({ level }) => (
  <span style={{ color: T.green, fontWeight: 700, fontSize: '0.85rem' }}>
    {'$'.repeat(level || 2)}
    <span style={{ color: T.border }}>{'$'.repeat(4 - (level || 2))}</span>
  </span>
);

const Screen = ({ children, sx = {} }) => (
  <div style={{
    maxWidth: 430, margin: '0 auto', minHeight: '100vh',
    background: T.bg, fontFamily: "'Noto Sans TC',sans-serif",
    color: T.dark, position: 'relative', overflow: 'hidden', ...sx,
  }}>{children}</div>
);

const Spinner = ({ size = 24, color = T.primary }) => (
  <div style={{
    width: size, height: size, borderRadius: '50%',
    border: `3px solid ${color}30`, borderTopColor: color,
    animation: 'spin 0.8s linear infinite', display: 'inline-block',
  }} />
);

// ─────────────────────────────────────────────────────────────────
// Keyframe styles (injected once)
// ─────────────────────────────────────────────────────────────────
if (!document.getElementById('ew-styles')) {
  const el = document.createElement('style');
  el.id = 'ew-styles';
  el.textContent = `
    @keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-12px)}}
    @keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
    @keyframes pop{0%{transform:scale(0.75);opacity:0}60%{transform:scale(1.05)}100%{transform:scale(1);opacity:1}}
    @keyframes fall{0%{transform:translateY(-30px) rotate(0);opacity:1}100%{transform:translateY(100vh) rotate(540deg);opacity:0}}
    @keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.35}}
  `;
  document.head.appendChild(el);
}

// ─────────────────────────────────────────────────────────────────
// SCREEN 1 — Login  (Firebase anonymous auth)
// ─────────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [tab, setTab] = useState('login');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const handle = async () => {
    if (!name.trim()) return;
    setLoading(true); setErr('');
    try {
      const { user } = await signInAnonymously(auth);
      onLogin(user.uid, name.trim());
    } catch (e) {
      setErr('登入失敗，請確認網路連線');
      setLoading(false);
    }
  };

  const inp = {
    width: '100%', padding: '14px 18px', borderRadius: 14,
    border: `1.5px solid ${T.border}`, background: '#fff',
    fontSize: '0.97rem', fontFamily: "'Noto Sans TC',sans-serif",
    color: T.dark, outline: 'none',
  };

  return (
    <Screen>
      <div style={{ position: 'absolute', top: -80, right: -80, width: 220, height: 220, borderRadius: '50%', background: `${T.primary}12`, zIndex: 0 }} />
      <div style={{ position: 'absolute', bottom: -60, left: -60, width: 180, height: 180, borderRadius: '50%', background: `${T.accent}15`, zIndex: 0 }} />

      <div style={{ position: 'relative', zIndex: 1, padding: '56px 26px 32px' }}>
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <div style={{ fontSize: '4.5rem', marginBottom: 8, display: 'inline-block', animation: 'bounce 2s ease-in-out infinite' }}>🍽️</div>
          <h1 style={{
            fontFamily: "'Nunito',sans-serif", fontSize: '2.3rem', fontWeight: 900, margin: 0,
            background: `linear-gradient(135deg,${T.primary},${T.accent})`,
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          }}>今天吃什麼？</h1>
          <p style={{ color: T.gray, margin: '8px 0 0', fontSize: '0.88rem' }}>和朋友一起決定，不再糾結！</p>
        </div>

        <div style={{ display: 'flex', background: T.border, borderRadius: 14, padding: 4, marginBottom: 22 }}>
          {[['login', '登入'], ['register', '註冊']].map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)} style={{
              flex: 1, padding: '11px', borderRadius: 12, border: 'none',
              background: tab === t ? '#fff' : 'transparent',
              color: tab === t ? T.primary : T.gray,
              fontWeight: 800, fontFamily: "'Noto Sans TC',sans-serif",
              cursor: 'pointer', transition: 'all 0.2s',
              boxShadow: tab === t ? '0 2px 10px rgba(0,0,0,0.07)' : 'none',
            }}>{label}</button>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 13, marginBottom: 18 }}>
          <input value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handle()}
            placeholder="你的暱稱" style={inp} />
          <input type="password" placeholder="密碼" style={inp} />
          {tab === 'register' && <input type="password" placeholder="確認密碼" style={inp} />}
          {err && <p style={{ color: T.red, fontSize: '0.82rem', margin: 0 }}>{err}</p>}
          <Btn onClick={handle} disabled={!name.trim() || loading}>
            {loading ? <Spinner size={18} color="#fff" /> : tab === 'login' ? '登入 →' : '建立帳號 →'}
          </Btn>
        </div>
        <p style={{ textAlign: 'center', color: T.gray, fontSize: '0.78rem' }}>
          🔒 使用匿名登入，無需個人資料
        </p>
      </div>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN 2 — Home
// ─────────────────────────────────────────────────────────────────
function HomeScreen({ uid, username, onCreate, onJoin }) {
  const [joining, setJoining] = useState(false);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const handleCreate = async () => {
    setLoading(true);
    const roomCode = genCode();
    await set(ref(db, `rooms/${roomCode}`), {
      host: uid, created: Date.now(), status: 'waiting',
      members: {
        [uid]: { name: username, ready: false, joined: Date.now() },
      },
    });
    onCreate(roomCode);
    setLoading(false);
  };

  const handleJoin = async () => {
    if (code.length !== 4) return;
    setLoading(true); setErr('');
    const snap = await get(ref(db, `rooms/${code}`));
    if (!snap.exists()) { setErr('找不到這個房間號碼'); setLoading(false); return; }
    if (snap.val().status !== 'waiting') { setErr('這個房間已經開始了'); setLoading(false); return; }
    await update(ref(db, `rooms/${code}/members/${uid}`), {
      name: username, ready: false, joined: Date.now(),
    });
    onJoin(code);
    setLoading(false);
  };

  return (
    <Screen>
      <div style={{ padding: '36px 22px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
          <div>
            <p style={{ margin: 0, color: T.gray, fontSize: '0.8rem' }}>歡迎回來</p>
            <h2 style={{ margin: '2px 0 0', fontSize: '1.35rem', fontWeight: 900 }}>{username} 👋</h2>
          </div>
          <div style={{
            width: 46, height: 46, borderRadius: '50%',
            background: `linear-gradient(135deg,${T.primary},${T.accent})`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: 900, fontSize: '1.2rem',
          }}>{username[0].toUpperCase()}</div>
        </div>

        <Card sx={{ background: `linear-gradient(150deg,${T.primary},${T.primaryD})`, border: 'none', marginBottom: 22, boxShadow: `0 8px 30px ${T.primary}40` }}>
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            <div style={{ fontSize: '2.8rem', marginBottom: 8 }}>🍽️</div>
            <h2 style={{ color: '#fff', margin: '0 0 8px', fontSize: '1.35rem', fontWeight: 900 }}>今天想吃什麼？</h2>
            <p style={{ color: 'rgba(255,255,255,0.75)', margin: 0, fontSize: '0.85rem', lineHeight: 1.6 }}>
              邀請朋友一起，讓 Google Maps 幫你們選
            </p>
          </div>
        </Card>

        {!joining ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Btn onClick={handleCreate} disabled={loading} sx={{ padding: '18px', fontSize: '1.05rem' }}>
              {loading ? <Spinner size={18} color="#fff" /> : '✨ 建立新房間'}
            </Btn>
            <Btn variant="outline" onClick={() => setJoining(true)} sx={{ padding: '18px', fontSize: '1.05rem' }}>
              🚪 加入房間
            </Btn>
          </div>
        ) : (
          <Card>
            <p style={{ margin: '0 0 14px', fontWeight: 800 }}>輸入房間號碼</p>
            <input value={code}
              onChange={e => { setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')); setErr(''); }}
              placeholder="A3B7" maxLength={4}
              style={{
                width: '100%', padding: '14px', borderRadius: 12,
                border: `2.5px solid ${code.length === 4 ? T.primary : T.border}`,
                fontSize: '2.2rem', fontWeight: 900, textAlign: 'center',
                letterSpacing: '10px', fontFamily: 'monospace', color: T.dark,
                outline: 'none', marginBottom: 12, transition: 'border-color 0.2s',
              }} />
            {err && <p style={{ color: T.red, fontSize: '0.82rem', marginBottom: 12 }}>{err}</p>}
            <div style={{ display: 'flex', gap: 10 }}>
              <Btn variant="ghost" onClick={() => { setJoining(false); setCode(''); setErr(''); }} sx={{ flex: 1 }}>取消</Btn>
              <Btn onClick={handleJoin} disabled={code.length !== 4 || loading} sx={{ flex: 2 }}>
                {loading ? <Spinner size={16} color="#fff" /> : '加入 →'}
              </Btn>
            </div>
          </Card>
        )}
      </div>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────
// Map component (Google Maps + member pins)
// ─────────────────────────────────────────────────────────────────
function MemberMap({ members, myLoc }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);

  useEffect(() => {
    loadMaps().then(() => {
      if (!divRef.current || mapRef.current) return;
      const center = myLoc || { lat: 22.9908, lng: 120.2133 }; // fallback: Tainan
      mapRef.current = new window.google.maps.Map(divRef.current, {
        center, zoom: 15,
        disableDefaultUI: true,
        styles: [
          { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
          { featureType: 'transit', stylers: [{ visibility: 'off' }] },
        ],
      });
    }).catch(() => {});
  }, []);

  // Update markers when members change
  useEffect(() => {
    if (!mapRef.current) return;
    markersRef.current.forEach(m => m.setMap(null));
    markersRef.current = [];
    const validMembers = Object.values(members).filter(m => m.lat && m.lng);
    validMembers.forEach(m => {
      const marker = new window.google.maps.Marker({
        position: { lat: m.lat, lng: m.lng },
        map: mapRef.current,
        title: m.name,
        label: { text: m.name[0], color: '#fff', fontWeight: 'bold' },
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 16,
          fillColor: m.ready ? T.green : T.primary,
          fillOpacity: 1,
          strokeColor: '#fff',
          strokeWeight: 2,
        },
      });
      markersRef.current.push(marker);
    });
    if (validMembers.length > 1) {
      const bounds = new window.google.maps.LatLngBounds();
      validMembers.forEach(m => bounds.extend({ lat: m.lat, lng: m.lng }));
      mapRef.current.fitBounds(bounds, 60);
    }
  }, [members]);

  return (
    <div ref={divRef} style={{
      width: '100%', height: 200, borderRadius: 16, overflow: 'hidden',
      background: '#E8F4FE', border: `1px solid ${T.border}`,
    }} />
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN 3 — Lobby  (real GPS + Firebase sync)
// ─────────────────────────────────────────────────────────────────
function LobbyScreen({ uid, username, roomCode, onProceed }) {
  const [members, setMembers] = useState({});
  const [myDist, setMyDist] = useState(2);
  const [myBudget, setMyBudget] = useState(300);
  const [myReady, setMyReady] = useState(false);
  const [myLoc, setMyLoc] = useState(null);
  const [locStatus, setLocStatus] = useState('idle'); // idle | loading | ok | err
  const [copied, setCopied] = useState(false);
  const [mapsLoaded, setMapsLoaded] = useState(false);

  // Load Maps SDK
  useEffect(() => { loadMaps().then(() => setMapsLoaded(true)).catch(() => {}); }, []);

  // Get GPS
  useEffect(() => {
    setLocStatus('loading');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const loc = { lat: coords.latitude, lng: coords.longitude };
        setMyLoc(loc);
        setLocStatus('ok');
        update(ref(db, `rooms/${roomCode}/members/${uid}`), { lat: loc.lat, lng: loc.lng });
      },
      () => setLocStatus('err'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, []);

  // Listen to room (real-time)
  useEffect(() => {
    const unsubscribe = onValue(ref(db, `rooms/${roomCode}/members`), snap => {
      setMembers(snap.val() || {});
    });
    return () => unsubscribe();
  }, [roomCode]);

  const memberList = Object.entries(members).map(([id, data]) => ({ id, ...data }));
  const allReady = memberList.length > 0 && memberList.every(m => m.ready);
  const readyCount = memberList.filter(m => m.ready).length;

  const handleReady = async () => {
    await update(ref(db, `rooms/${roomCode}/members/${uid}`), {
      distance: myDist, budget: myBudget, ready: true,
    });
    setMyReady(true);
  };

  const handleCopy = () => {
    navigator.clipboard?.writeText(roomCode).catch(() => {});
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };

  const handleStart = async () => {
    await update(ref(db, `rooms/${roomCode}`), { status: 'started' });
    onProceed(memberList);
  };

  const sliderSx = { width: '100%', height: 4 };

  return (
    <Screen>
      <div style={{ padding: '24px 20px 36px' }}>
        {/* Room header */}
        <Card sx={{ marginBottom: 14, padding: '16px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <p style={{ margin: 0, color: T.gray, fontSize: '0.78rem', fontWeight: 600 }}>房間號碼</p>
              <span style={{ fontFamily: 'monospace', fontSize: '2rem', fontWeight: 900, color: T.primary, letterSpacing: '6px' }}>{roomCode}</span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <button onClick={handleCopy} style={{
                background: copied ? T.greenLight : `${T.primary}18`,
                border: 'none', borderRadius: 10, padding: '8px 14px',
                cursor: 'pointer', fontSize: '0.82rem', fontWeight: 700,
                color: copied ? T.green : T.primary, fontFamily: 'inherit', transition: 'all 0.2s',
              }}>{copied ? '✓ 已複製' : '複製邀請碼'}</button>
              <p style={{ margin: '6px 0 0', color: T.gray, fontSize: '0.75rem' }}>{memberList.length}/6 人</p>
            </div>
          </div>
          {/* Progress bar */}
          <div style={{ display: 'flex', gap: 5, marginTop: 12 }}>
            {memberList.map((_, i) => (
              <div key={i} style={{
                flex: 1, height: 5, borderRadius: 4,
                background: i < readyCount ? T.green : T.border,
                transition: 'background 0.4s',
              }} />
            ))}
          </div>
          <p style={{ margin: '5px 0 0', fontSize: '0.74rem', color: T.gray }}>{readyCount}/{memberList.length} 人已準備</p>
        </Card>

        {/* GPS status */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14,
          padding: '10px 16px', borderRadius: 12,
          background: locStatus === 'ok' ? T.greenLight : locStatus === 'err' ? '#FFE8EA' : T.lightBg,
          border: `1px solid ${locStatus === 'ok' ? T.green : locStatus === 'err' ? T.red : T.border}`,
        }}>
          {locStatus === 'loading' && <Spinner size={16} color={T.primary} />}
          <span style={{ fontSize: '0.82rem', fontWeight: 600, color: locStatus === 'ok' ? T.green : locStatus === 'err' ? T.red : T.gray }}>
            {locStatus === 'idle' && '準備取得位置…'}
            {locStatus === 'loading' && '正在取得你的 GPS 位置…'}
            {locStatus === 'ok' && '📍 已取得位置，已同步到房間'}
            {locStatus === 'err' && '⚠️ 無法取得 GPS，請允許位置權限'}
          </span>
        </div>

        {/* Map */}
        {mapsLoaded && (
          <div style={{ marginBottom: 14 }}>
            <MemberMap members={members} myLoc={myLoc} />
            <p style={{ fontSize: '0.73rem', color: T.gray, margin: '6px 0 0', textAlign: 'center' }}>
              🟠 = 等待中　🟢 = 已準備
            </p>
          </div>
        )}

        {/* Members list */}
        <Card sx={{ marginBottom: 14 }}>
          <p style={{ margin: '0 0 14px', fontWeight: 800, fontSize: '0.92rem', color: T.gray }}>🧑‍🤝‍🧑 房間成員</p>
          {memberList.map((m, i) => (
            <div key={m.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '11px 0', borderBottom: i < memberList.length - 1 ? `1px solid ${T.border}` : 'none',
            }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: '0.92rem' }}>
                  {m.name}{m.id === uid && <span style={{ color: T.primary, fontSize: '0.74rem', marginLeft: 5 }}>(你)</span>}
                </div>
                {m.ready && (
                  <div style={{ fontSize: '0.72rem', color: T.gray, marginTop: 1 }}>
                    📍 {m.distance}km · 💰 NT${m.budget}
                    {m.lat && <span> · 📡 已定位</span>}
                  </div>
                )}
              </div>
              <span style={{
                padding: '4px 13px', borderRadius: 20, fontSize: '0.77rem', fontWeight: 700,
                background: m.ready ? T.greenLight : T.lightBg,
                color: m.ready ? T.green : T.gray, transition: 'all 0.3s',
              }}>{m.ready ? '✓ 準備好' : '等待中…'}</span>
            </div>
          ))}
        </Card>

        {/* My settings */}
        {!myReady && (
          <Card sx={{ marginBottom: 14, animation: 'fadeIn 0.4s ease' }}>
            <p style={{ margin: '0 0 18px', fontWeight: 800, fontSize: '0.92rem', color: T.gray }}>⚙️ 我的設定</p>
            <div style={{ marginBottom: 22 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <label style={{ fontWeight: 700, fontSize: '0.88rem' }}>🚶 可移動距離</label>
                <span style={{ fontWeight: 900, color: T.primary, fontSize: '1.05rem' }}>{myDist} km</span>
              </div>
              <input type="range" min={0.3} max={10} step={0.2} value={myDist}
                onChange={e => setMyDist(+e.target.value)} style={sliderSx} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: T.gray, marginTop: 4 }}>
                <span>300m</span><span>10 km</span>
              </div>
            </div>
            <div style={{ marginBottom: 22 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <label style={{ fontWeight: 700, fontSize: '0.88rem' }}>💰 這餐預算</label>
                <span style={{ fontWeight: 900, color: T.primary, fontSize: '1.05rem' }}>NT${myBudget}</span>
              </div>
              <input type="range" min={50} max={1200} step={50} value={myBudget}
                onChange={e => setMyBudget(+e.target.value)} style={sliderSx} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: T.gray, marginTop: 4 }}>
                <span>NT$50</span><span>NT$1200</span>
              </div>
            </div>
            <Btn onClick={handleReady} disabled={locStatus === 'loading'}>✅ 我準備好了！</Btn>
          </Card>
        )}

        {myReady && !allReady && (
          <Card sx={{ marginBottom: 14, textAlign: 'center' }}>
            <div style={{ fontSize: '2rem', marginBottom: 6, animation: 'pulse 1.5s ease infinite' }}>⏳</div>
            <p style={{ fontWeight: 800, margin: '0 0 4px' }}>等待其他成員準備中…</p>
            <p style={{ color: T.gray, fontSize: '0.83rem', margin: 0 }}>分享房間號碼 <strong style={{ color: T.primary }}>{roomCode}</strong> 給朋友</p>
          </Card>
        )}

        {allReady && (
          <Card sx={{
            marginBottom: 14, textAlign: 'center',
            background: `linear-gradient(150deg,${T.green},#2D6A4F)`, border: 'none',
            boxShadow: `0 8px 28px ${T.green}50`, animation: 'pop 0.5s cubic-bezier(0.34,1.56,0.64,1)',
          }}>
            <div style={{ fontSize: '2.5rem', marginBottom: 10 }}>🎉</div>
            <p style={{ color: '#fff', fontWeight: 800, margin: '0 0 16px', fontSize: '1.05rem' }}>所有人都準備好了！</p>
            <Btn variant="accent" onClick={handleStart} sx={{ padding: '16px', fontSize: '1.05rem' }}>
              🗺️ 開始找餐廳！
            </Btn>
          </Card>
        )}
      </div>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN 4 — Mode Select
// ─────────────────────────────────────────────────────────────────
function ModeScreen({ onMode }) {
  return (
    <Screen>
      <div style={{ padding: '56px 24px', textAlign: 'center' }}>
        <div style={{ fontSize: '3.5rem', marginBottom: 14 }}>🎯</div>
        <h2 style={{ fontSize: '1.55rem', fontWeight: 900, margin: '0 0 8px' }}>選擇決定方式</h2>
        <p style={{ color: T.gray, margin: '0 0 40px', fontSize: '0.88rem' }}>你們想怎麼決定今天吃什麼？</p>

        {[
          { mode: 'random', emoji: '🎲', title: '隨機選擇', desc: '讓命運來決定！從符合所有人條件的餐廳中隨機挑一間', accent: false },
          { mode: 'vote',   emoji: '🗳️', title: '投票決定', desc: '列出所有符合的餐廳，大家投票，最高票勝出',            accent: true },
        ].map(({ mode, emoji, title, desc, accent }) => (
          <button key={mode} onClick={() => onMode(mode)} style={{
            display: 'block', width: '100%', marginBottom: 16,
            padding: 24, borderRadius: 24, textAlign: 'left', cursor: 'pointer',
            border: `2px solid ${accent ? T.primary : T.border}`,
            background: accent ? `${T.primary}08` : '#fff',
            boxShadow: accent ? `0 6px 24px ${T.primary}25` : '0 2px 12px rgba(0,0,0,0.04)',
            fontFamily: "'Noto Sans TC',sans-serif", transition: 'all 0.2s',
          }}>
            <div style={{ fontSize: '2.5rem', marginBottom: 10 }}>{emoji}</div>
            <h3 style={{ margin: '0 0 8px', fontSize: '1.15rem', fontWeight: 900, color: T.dark }}>{title}</h3>
            <p style={{ margin: 0, color: T.gray, fontSize: '0.83rem', lineHeight: 1.6 }}>{desc}</p>
            {accent && <Tag color={T.primary}>推薦</Tag>}
          </button>
        ))}
      </div>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN 5 — Searching  (real Google Places API call)
// ─────────────────────────────────────────────────────────────────
function SearchingScreen({ memberList, roomCode, onDone }) {
  const [step, setStep] = useState(0);
  const [err, setErr] = useState('');

  const steps = [
    '📍 計算各成員位置…',
    '🗺️ 計算共同搜尋範圍…',
    '🔍 搜尋 Google Maps 餐廳…',
    '💰 篩選符合預算的餐廳…',
    '✅ 找到符合的餐廳！',
  ];

  useEffect(() => {
    const run = async () => {
      try {
        await loadMaps();
        setStep(1);

        // Collect member locations
        const located = memberList.filter(m => m.lat && m.lng);
        const locs = located.length > 0
          ? located.map(m => ({ lat: m.lat, lng: m.lng }))
          : [{ lat: 22.9908, lng: 120.2133 }]; // fallback: Tainan city center

        setStep(2);
        const center = centerOf(locs);

        // Min of all members' distances and budgets
        const ready = memberList.filter(m => m.ready);
        const radius = Math.min(...ready.map(m => m.distance ?? 2));
        const budget = Math.min(...ready.map(m => m.budget ?? 300));

        setStep(3);
        const restaurants = await searchRestaurants(center, radius, budget);
        setStep(4);

        // Save to Firebase
        await update(ref(db, `rooms/${roomCode}`), {
          restaurants: restaurants.slice(0, 12),
          centerLat: center.lat,
          centerLng: center.lng,
          status: 'searching_done',
        });

        setStep(5);
        setTimeout(() => onDone(restaurants), 600);
      } catch (e) {
        console.error(e);
        setErr('搜尋失敗：' + (e.message || '請確認 API 金鑰'));
      }
    };
    run();
  }, []);

  return (
    <Screen>
      <div style={{ padding: '80px 28px', textAlign: 'center' }}>
        {err ? (
          <Card sx={{ textAlign: 'center' }}>
            <div style={{ fontSize: '3rem', marginBottom: 12 }}>⚠️</div>
            <p style={{ fontWeight: 800, marginBottom: 8 }}>搜尋時發生錯誤</p>
            <p style={{ color: T.gray, fontSize: '0.85rem', marginBottom: 16 }}>{err}</p>
            <p style={{ color: T.gray, fontSize: '0.8rem' }}>請確認 Google Maps API 金鑰已啟用<br />Maps JavaScript API + Places API</p>
          </Card>
        ) : (
          <>
            <div style={{ fontSize: '4rem', marginBottom: 24, display: 'inline-block', animation: 'spin 2.5s linear infinite' }}>🔍</div>
            <h2 style={{ fontSize: '1.45rem', fontWeight: 900, margin: '0 0 10px' }}>搜尋中…</h2>
            <p style={{ color: T.gray, margin: '0 0 32px', minHeight: '1.4em', fontSize: '0.9rem' }}>{steps[Math.min(step, steps.length - 1)]}</p>

            <div style={{ background: T.border, borderRadius: 20, height: 12, overflow: 'hidden', marginBottom: 8 }}>
              <div style={{
                height: '100%', borderRadius: 20,
                background: `linear-gradient(90deg,${T.primary},${T.accent})`,
                width: `${(step / steps.length) * 100}%`, transition: 'width 0.5s ease',
              }} />
            </div>
            <span style={{ fontWeight: 900, color: T.primary }}>{Math.round((step / steps.length) * 100)}%</span>

            <div style={{ marginTop: 48, display: 'flex', justifyContent: 'center', gap: 16, fontSize: '1.8rem' }}>
              {['🍜', '🍕', '🌮', '🍣', '🥗'].map((e, i) => (
                <span key={i} style={{ display: 'inline-block', animation: `bounce 1.2s ${i * 0.18}s ease-in-out infinite` }}>{e}</span>
              ))}
            </div>
          </>
        )}
      </div>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN 6 — Random Result
// ─────────────────────────────────────────────────────────────────
function RandomResultScreen({ restaurant, onRestart }) {
  const [show, setShow] = useState(false);
  useEffect(() => { setTimeout(() => setShow(true), 300); }, []);

  const confetti = Array.from({ length: 24 }, (_, i) => ({
    x: (i * 43) % 100, delay: i * 0.07,
    color: [T.primary, T.accent, T.green, T.red, '#9381FF'][i % 5],
    dur: 1.2 + ((i * 31) % 10) * 0.15,
  }));

  if (!restaurant) return (
    <Screen><div style={{ padding: '80px 24px', textAlign: 'center' }}>
      <p style={{ color: T.gray }}>沒有找到符合條件的餐廳，請調整距離或預算</p>
      <Btn onClick={onRestart} sx={{ marginTop: 24 }}>↩ 重新開始</Btn>
    </div></Screen>
  );

  return (
    <Screen>
      <div style={{ padding: '32px 24px', textAlign: 'center' }}>
        <p style={{ color: T.gray, margin: '0 0 6px', fontSize: '0.88rem' }}>🎲 命運選擇了</p>
        <h2 style={{ fontSize: '1.35rem', fontWeight: 900, margin: '0 0 28px' }}>今天就吃這間！</h2>

        {show && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 10 }}>
            {confetti.map((c, i) => (
              <div key={i} style={{
                position: 'absolute', left: `${c.x}%`, top: '-20px',
                width: 10, height: 10, borderRadius: i % 3 === 0 ? 0 : '50%',
                background: c.color, animation: `fall ${c.dur}s ${c.delay}s ease-in forwards`,
              }} />
            ))}
          </div>
        )}

        <Card sx={{
          marginBottom: 22,
          transform: show ? 'scale(1)' : 'scale(0.7)', opacity: show ? 1 : 0,
          transition: 'all 0.55s cubic-bezier(0.34,1.56,0.64,1)',
          border: `2px solid ${T.primary}`, boxShadow: `0 12px 40px ${T.primary}30`,
        }}>
          {restaurant.photo
            ? <img src={restaurant.photo} alt={restaurant.name}
                style={{ width: '100%', height: 160, objectFit: 'cover', borderRadius: 12, marginBottom: 14 }} />
            : <div style={{ fontSize: '5rem', marginBottom: 14, animation: show ? 'bounce 2s ease-in-out infinite' : 'none' }}>🍽️</div>
          }
          <h1 style={{ fontSize: '1.7rem', fontWeight: 900, margin: '0 0 6px' }}>{restaurant.name}</h1>
          <p style={{ color: T.gray, fontSize: '0.83rem', margin: '0 0 12px' }}>{restaurant.address}</p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 24, marginBottom: 12 }}>
            <div style={{ textAlign: 'center' }}>
              <Stars r={restaurant.rating} />
              <div style={{ color: T.gray, fontSize: '0.7rem', marginTop: 2 }}>{restaurant.reviews.toLocaleString()} 評論</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <PriceTag level={restaurant.priceLevel} />
              <div style={{ color: T.gray, fontSize: '0.7rem', marginTop: 2 }}>價位</div>
            </div>
          </div>
        </Card>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
          <Btn variant="green" onClick={() => window.open(restaurant.mapsUrl, '_blank')}>
            🗺️ 在 Google Maps 開啟
          </Btn>
          <Btn variant="ghost" onClick={onRestart} sx={{ padding: '12px' }}>↩ 重新開始</Btn>
        </div>
      </div>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN 7 — Vote  (Firebase-synced votes)
// ─────────────────────────────────────────────────────────────────
function VoteScreen({ uid, restaurants, roomCode, onRestart }) {
  const [myVote, setMyVote] = useState(null);
  const [votes, setVotes] = useState({});     // { uid: restaurantId }
  const [revealed, setRevealed] = useState(false);

  // Listen to votes in real-time
  useEffect(() => {
    const unsub = onValue(ref(db, `rooms/${roomCode}/votes`), snap => {
      const data = snap.val() || {};
      setVotes(data);
    });
    return () => unsub();
  }, [roomCode]);

  const handleVote = async (id) => {
    if (myVote || revealed) return;
    setMyVote(id);
    await set(ref(db, `rooms/${roomCode}/votes/${uid}`), id);
  };

  // Tally votes by restaurant id
  const tally = {};
  Object.values(votes).forEach(id => { tally[id] = (tally[id] || 0) + 1; });
  const totalVotes = Object.values(tally).reduce((a, b) => a + b, 0);
  const sorted = [...restaurants].sort((a, b) => (tally[b.id] || 0) - (tally[a.id] || 0));
  const winner = sorted[0];

  return (
    <Screen>
      <div style={{ padding: '24px 20px 40px' }}>
        {!revealed ? (
          <>
            <div style={{ textAlign: 'center', marginBottom: 22 }}>
              <h2 style={{ fontSize: '1.4rem', fontWeight: 900, margin: '0 0 6px' }}>
                {myVote ? '等待其他人投票…' : '投票選擇餐廳'}
              </h2>
              <p style={{ color: T.gray, fontSize: '0.85rem', margin: 0 }}>
                {myVote ? `已投票 ${totalVotes} 人` : '點選你最想吃的餐廳'}
              </p>
            </div>

            {restaurants.map(r => (
              <button key={r.id} onClick={() => handleVote(r.id)} style={{
                display: 'block', width: '100%', marginBottom: 12,
                padding: '16px 18px', borderRadius: 18, textAlign: 'left',
                border: `2px solid ${myVote === r.id ? T.primary : T.border}`,
                background: myVote === r.id ? `${T.primary}10` : '#fff',
                cursor: myVote ? 'default' : 'pointer',
                transform: myVote === r.id ? 'scale(1.015)' : 'scale(1)',
                boxShadow: myVote === r.id ? `0 4px 18px ${T.primary}30` : 'none',
                fontFamily: "'Noto Sans TC',sans-serif", transition: 'all 0.22s',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {r.photo
                    ? <img src={r.photo} style={{ width: 52, height: 52, borderRadius: 10, objectFit: 'cover' }} />
                    : <div style={{ width: 52, height: 52, borderRadius: 10, background: T.lightBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.8rem' }}>🍽️</div>
                  }
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: '0.97rem', marginBottom: 3 }}>{r.name}</div>
                    <div style={{ color: T.gray, fontSize: '0.78rem' }}>
                      <Stars r={r.rating} /> &nbsp;·&nbsp; <PriceTag level={r.priceLevel} />
                    </div>
                    <div style={{ color: T.gray, fontSize: '0.75rem', marginTop: 2 }}>{r.address}</div>
                  </div>
                  {myVote === r.id && <span style={{ fontSize: '1.4rem', color: T.primary }}>✓</span>}
                </div>
              </button>
            ))}

            {myVote && (
              <Btn variant="accent" onClick={() => setRevealed(true)} sx={{ marginTop: 8 }}>
                📊 揭曉投票結果
              </Btn>
            )}
          </>
        ) : (
          <>
            <div style={{ textAlign: 'center', marginBottom: 22, animation: 'fadeIn 0.5s ease' }}>
              <div style={{ fontSize: '3rem', marginBottom: 8 }}>🏆</div>
              <h2 style={{ fontSize: '1.4rem', fontWeight: 900, margin: '0 0 4px' }}>投票結果揭曉！</h2>
              <p style={{ color: T.gray, margin: 0, fontSize: '0.85rem' }}>共 {totalVotes} 票</p>
            </div>

            {winner && (
              <Card sx={{
                marginBottom: 18, textAlign: 'center',
                background: `${T.primary}10`,
                border: `2px solid ${T.primary}`, boxShadow: `0 8px 30px ${T.primary}30`,
                animation: 'pop 0.5s cubic-bezier(0.34,1.56,0.64,1)',
              }}>
                {winner.photo && <img src={winner.photo} style={{ width: '100%', height: 140, objectFit: 'cover', borderRadius: 12, marginBottom: 12 }} />}
                <h2 style={{ margin: '0 0 8px', fontSize: '1.45rem', fontWeight: 900 }}>{winner.name}</h2>
                <p style={{ color: T.gray, fontSize: '0.83rem', margin: '0 0 10px' }}>{winner.address}</p>
                <div style={{ fontWeight: 900, color: T.primary, fontSize: '1.1rem' }}>
                  🏆 {tally[winner.id] || 0}/{totalVotes} 票
                </div>
              </Card>
            )}

            {sorted.map((r, i) => (
              <div key={r.id} style={{
                display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10,
                padding: '12px 16px', borderRadius: 16,
                background: i === 0 ? T.card : `${T.lightBg}`,
                border: `1.5px solid ${i === 0 ? T.primary : T.border}`,
                animation: `fadeIn 0.4s ${i * 0.1}s ease both`,
              }}>
                <span style={{ fontWeight: 900, fontSize: '1rem', color: i === 0 ? T.primary : T.gray, minWidth: 24 }}>
                  {['🥇', '🥈', '🥉'][i] || `#${i + 1}`}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{r.name}</div>
                  <div style={{ color: T.gray, fontSize: '0.75rem' }}>{r.address}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 900, color: i === 0 ? T.primary : T.gray }}>{tally[r.id] || 0}票</div>
                  <div style={{ height: 5, borderRadius: 3, background: T.border, width: 60, overflow: 'hidden', marginTop: 4, marginLeft: 'auto' }}>
                    <div style={{
                      height: '100%', borderRadius: 3,
                      background: i === 0 ? T.primary : T.gray,
                      width: `${totalVotes ? Math.round((tally[r.id] || 0) / totalVotes * 100) : 0}%`,
                    }} />
                  </div>
                </div>
              </div>
            ))}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 13, marginTop: 18 }}>
              {winner && (
                <Btn variant="green" onClick={() => window.open(winner.mapsUrl, '_blank')}>
                  🗺️ 在 Google Maps 開啟
                </Btn>
              )}
              <Btn variant="ghost" onClick={onRestart} sx={{ padding: '12px' }}>↩ 重新開始</Btn>
            </div>
          </>
        )}
      </div>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState('login');
  const [uid, setUid] = useState('');
  const [username, setUsername] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [mode, setMode] = useState(null);
  const [memberList, setMemberList] = useState([]);
  const [restaurants, setRestaurants] = useState([]);
  const [pick, setPick] = useState(null);

  // Handle login
  const handleLogin = (firebaseUid, name) => {
    setUid(firebaseUid);
    setUsername(name);
    setScreen('home');
  };

  const handleCreate = (code) => { setRoomCode(code); setScreen('lobby'); };
  const handleJoin   = (code) => { setRoomCode(code); setScreen('lobby'); };

  const handleProceed = (members) => {
    setMemberList(members);
    setScreen('mode');
  };

  const handleMode = (m) => {
    setMode(m);
    setScreen('searching');
  };

  const handleSearchDone = (results) => {
    setRestaurants(results);
    if (mode === 'random') {
      setPick(results[Math.floor(Math.random() * results.length)] ?? null);
      setScreen('random');
    } else {
      setScreen('vote');
    }
  };

  const handleRestart = () => {
    // Clean up Firebase room if host
    setScreen('home');
    setRoomCode('');
    setRestaurants([]);
    setPick(null);
    setMode(null);
  };

  return (
    <div style={{ background: '#FFF0E0', minHeight: '100vh' }}>
      {screen === 'login'     && <LoginScreen onLogin={handleLogin} />}
      {screen === 'home'      && <HomeScreen uid={uid} username={username} onCreate={handleCreate} onJoin={handleJoin} />}
      {screen === 'lobby'     && <LobbyScreen uid={uid} username={username} roomCode={roomCode} onProceed={handleProceed} />}
      {screen === 'mode'      && <ModeScreen onMode={handleMode} />}
      {screen === 'searching' && <SearchingScreen memberList={memberList} roomCode={roomCode} onDone={handleSearchDone} />}
      {screen === 'random'    && <RandomResultScreen restaurant={pick} onRestart={handleRestart} />}
      {screen === 'vote'      && <VoteScreen uid={uid} restaurants={restaurants} roomCode={roomCode} onRestart={handleRestart} />}
    </div>
  );
}
