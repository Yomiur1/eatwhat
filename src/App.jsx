import { useState, useEffect, useRef } from 'react';
import {
  ref, set, get, onValue, update, remove, onDisconnect,
} from 'firebase/database';
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged,
} from 'firebase/auth';
import { db, auth } from './firebase';

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────
const DEMO = { username: 'demo', password: 'demo1234', displayName: '示範帳號' };
const toEmail = (u) => `${u.toLowerCase().trim()}@eatwhat.app`;
const genCode = () => {
  const c = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => c[Math.floor(Math.random() * c.length)]).join('');
};

// ─────────────────────────────────────────────────────────────────
// Theme
// ─────────────────────────────────────────────────────────────────
const T = {
  primary: '#FF6B35', primaryD: '#D9521F',
  accent: '#FFB703', accentD: '#E09E00',
  bg: '#FFFAF4', card: '#FFFFFF',
  dark: '#2A1600', gray: '#8C7355',
  border: '#EFD9C2', lightBg: '#FFF3E4',
  green: '#40916C', greenLight: '#D8F3DC',
  red: '#E63946', blue: '#1565C0',
};

// ─────────────────────────────────────────────────────────────────
// Google Maps
// ─────────────────────────────────────────────────────────────────
let _mapsPromise = null;
const loadMaps = () => {
  if (_mapsPromise) return _mapsPromise;
  _mapsPromise = new Promise((resolve, reject) => {
    if (window.google?.maps) { resolve(); return; }
    window.__mapsCallback = resolve;
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${import.meta.env.VITE_GOOGLE_MAPS_API_KEY}&libraries=places&callback=__mapsCallback&language=zh-TW&region=TW`;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return _mapsPromise;
};

const centerOf = (coords) => ({
  lat: coords.reduce((s, c) => s + c.lat, 0) / coords.length,
  lng: coords.reduce((s, c) => s + c.lng, 0) / coords.length,
});
const budgetToLevel = (b) => b < 150 ? 1 : b < 300 ? 2 : b < 600 ? 3 : 4;

const searchRestaurants = (center, radiusKm, maxBudget) =>
  new Promise((resolve) => {
    const div = document.createElement('div');
    div.style.cssText = 'width:1px;height:1px;position:fixed;opacity:0;top:0;left:0;';
    document.body.appendChild(div);
    const map = new window.google.maps.Map(div, { center, zoom: 15 });
    const svc = new window.google.maps.places.PlacesService(map);
    svc.nearbySearch(
      { location: center, radius: Math.min(radiusKm * 1000, 50000), type: 'restaurant' },
      (results, status) => {
        document.body.removeChild(div);
        if (status !== 'OK' || !results) { resolve([]); return; }
        resolve(results
          .filter(r => r.business_status === 'OPERATIONAL')
          .filter(r => (r.price_level ?? 2) <= budgetToLevel(maxBudget))
          .slice(0, 16)
          .map(r => ({
            id: r.place_id, name: r.name, address: r.vicinity,
            rating: r.rating ?? 0, reviews: r.user_ratings_total ?? 0,
            priceLevel: r.price_level ?? 2,
            lat: r.geometry.location.lat(), lng: r.geometry.location.lng(),
            photo: r.photos?.[0]?.getUrl({ maxWidth: 400 }) ?? null,
            mapsUrl: `https://www.google.com/maps/place/?q=place_id:${r.place_id}`,
          })));
      });
  });

// ─────────────────────────────────────────────────────────────────
// Firebase Auth helpers
// ─────────────────────────────────────────────────────────────────
const registerUser = async (username, password, displayName) => {
  const uname = username.toLowerCase().trim();
  const snap = await get(ref(db, `usernames/${uname}`));
  if (snap.exists()) throw new Error('此使用者名稱已被使用');
  const { user } = await createUserWithEmailAndPassword(auth, toEmail(uname), password);
  await Promise.all([
    set(ref(db, `users/${user.uid}`), { username: uname, displayName: displayName || uname, activeRoom: null, createdAt: Date.now() }),
    set(ref(db, `usernames/${uname}`), user.uid),
  ]);
  return user;
};

const loginUser = async (username, password) => {
  const { user } = await signInWithEmailAndPassword(auth, toEmail(username.toLowerCase().trim()), password);
  return user;
};

const ensureDemoAccount = async () => {
  try {
    const snap = await get(ref(db, `usernames/${DEMO.username}`));
    if (!snap.exists()) {
      const { user } = await createUserWithEmailAndPassword(auth, toEmail(DEMO.username), DEMO.password);
      await Promise.all([
        set(ref(db, `users/${user.uid}`), { username: DEMO.username, displayName: DEMO.displayName, activeRoom: null, createdAt: Date.now() }),
        set(ref(db, `usernames/${DEMO.username}`), user.uid),
      ]);
      await signOut(auth);
    }
  } catch (_) {}
};

// ─────────────────────────────────────────────────────────────────
// Firebase friend helpers
// ─────────────────────────────────────────────────────────────────
const findUserByUsername = async (username) => {
  const snap = await get(ref(db, `usernames/${username.toLowerCase().trim()}`));
  if (!snap.exists()) return null;
  const uid = snap.val();
  const uSnap = await get(ref(db, `users/${uid}`));
  return uSnap.exists() ? { uid, ...uSnap.val() } : null;
};
const sendFriendReq = async (fromUid, fromUsername, toUid) =>
  set(ref(db, `friendRequests/${toUid}/${fromUid}`), { fromUsername, createdAt: Date.now() });
const acceptFriendReq = async (myUid, myUsername, fromUid, fromUsername) => {
  const now = Date.now();
  await Promise.all([
    set(ref(db, `friends/${myUid}/${fromUid}`), { username: fromUsername, since: now }),
    set(ref(db, `friends/${fromUid}/${myUid}`), { username: myUsername, since: now }),
    remove(ref(db, `friendRequests/${myUid}/${fromUid}`)),
  ]);
};
const declineFriendReq = async (myUid, fromUid) => remove(ref(db, `friendRequests/${myUid}/${fromUid}`));

// ─────────────────────────────────────────────────────────────────
// Animations
// ─────────────────────────────────────────────────────────────────
if (!document.getElementById('ew-v2-styles')) {
  const el = document.createElement('style');
  el.id = 'ew-v2-styles';
  el.textContent = `
    @keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-12px)}}
    @keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
    @keyframes pop{0%{transform:scale(.75);opacity:0}60%{transform:scale(1.05)}100%{transform:scale(1);opacity:1}}
    @keyframes fall{0%{transform:translateY(-30px) rotate(0);opacity:1}100%{transform:translateY(100vh) rotate(540deg);opacity:0}}
    @keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
    @keyframes slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
  `;
  document.head.appendChild(el);
}

// ─────────────────────────────────────────────────────────────────
// Base UI components
// ─────────────────────────────────────────────────────────────────
const Btn = ({ children, onClick, variant = 'primary', disabled = false, small = false, sx = {} }) => {
  const V = {
    primary: { background: `linear-gradient(160deg,${T.primary},${T.primaryD})`, color: '#fff', border: 'none', boxShadow: `0 4px 14px ${T.primary}50` },
    accent:  { background: `linear-gradient(160deg,${T.accent},${T.accentD})`, color: '#fff', border: 'none' },
    outline: { background: 'transparent', color: T.primary, border: `2px solid ${T.primary}` },
    ghost:   { background: T.lightBg, color: T.gray, border: `1.5px solid ${T.border}` },
    green:   { background: `linear-gradient(160deg,${T.green},#2D6A4F)`, color: '#fff', border: 'none', boxShadow: `0 4px 14px ${T.green}50` },
    danger:  { background: `linear-gradient(160deg,${T.red},#B51B26)`, color: '#fff', border: 'none' },
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{
      ...V[variant], padding: small ? '9px 16px' : '14px 24px',
      borderRadius: 16, fontWeight: 800, fontSize: small ? '0.82rem' : '0.97rem',
      fontFamily: "'Noto Sans TC',sans-serif", cursor: disabled ? 'not-allowed' : 'pointer',
      width: '100%', opacity: disabled ? 0.45 : 1, transition: 'all 0.18s', ...sx,
    }}>{children}</button>
  );
};
const Card = ({ children, sx = {}, onClick }) => (
  <div onClick={onClick} style={{ background: T.card, borderRadius: 22, padding: 20, boxShadow: '0 6px 28px rgba(255,107,53,0.07)', border: `1px solid ${T.border}`, cursor: onClick ? 'pointer' : 'default', ...sx }}>{children}</div>
);
const Stars = ({ r = 0 }) => (
  <span style={{ color: T.accent, fontSize: '0.8rem' }}>
    {'★'.repeat(Math.floor(r))}{r % 1 >= 0.5 ? '☆' : ''}
    <span style={{ color: T.gray, marginLeft: 3 }}>{r.toFixed(1)}</span>
  </span>
);
const Spinner = ({ size = 20, color = T.primary }) => (
  <div style={{ width: size, height: size, borderRadius: '50%', border: `3px solid ${color}30`, borderTopColor: color, animation: 'spin 0.8s linear infinite', display: 'inline-block' }} />
);
const Screen = ({ children, sx = {} }) => (
  <div style={{ maxWidth: 430, margin: '0 auto', minHeight: '100vh', background: T.bg, fontFamily: "'Noto Sans TC',sans-serif", color: T.dark, position: 'relative', overflow: 'hidden', ...sx }}>{children}</div>
);
const inp = { width: '100%', padding: '14px 18px', borderRadius: 14, border: `1.5px solid ${T.border}`, background: '#fff', fontSize: '0.97rem', fontFamily: "'Noto Sans TC',sans-serif", color: T.dark, outline: 'none' };

// 房主標籤
const HostBadge = () => (
  <span style={{ background: `${T.accent}25`, color: T.accentD, borderRadius: 20, padding: '2px 10px', fontSize: '0.72rem', fontWeight: 800, marginLeft: 6 }}>房主</span>
);

// ─────────────────────────────────────────────────────────────────
// SCREEN 1 — Login
// ─────────────────────────────────────────────────────────────────
function LoginScreen({ onLogin, onRegister }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const doLogin = async (u, p) => {
    setLoading(true); setErr('');
    try {
      const user = await loginUser(u, p);
      const snap = await get(ref(db, `users/${user.uid}`));
      if (!snap.exists()) throw new Error('no_profile');
      onLogin(user.uid, snap.val().username, snap.val().displayName);
    } catch (e) {
      setErr('帳號或密碼錯誤');
      setLoading(false);
    }
  };

  return (
    <Screen>
      <div style={{ position: 'absolute', top: -80, right: -80, width: 220, height: 220, borderRadius: '50%', background: `${T.primary}12`, zIndex: 0 }} />
      <div style={{ position: 'absolute', bottom: -60, left: -60, width: 180, height: 180, borderRadius: '50%', background: `${T.accent}15`, zIndex: 0 }} />
      <div style={{ position: 'relative', zIndex: 1, padding: '52px 26px 32px' }}>
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{ fontSize: '4.5rem', marginBottom: 8, display: 'inline-block', animation: 'bounce 2s ease-in-out infinite' }}>🍽️</div>
          <h1 style={{ fontFamily: "'Nunito',sans-serif", fontSize: '2.3rem', fontWeight: 900, margin: 0, background: `linear-gradient(135deg,${T.primary},${T.accent})`, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>今天吃什麼？</h1>
          <p style={{ color: T.gray, margin: '8px 0 0', fontSize: '0.88rem' }}>V2 — 好友系統 · 即時同步投票</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 13, marginBottom: 16 }}>
          <input value={username} onChange={e => setUsername(e.target.value)} onKeyDown={e => e.key === 'Enter' && doLogin(username, password)} placeholder="使用者名稱" style={inp} />
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && doLogin(username, password)} placeholder="密碼" style={inp} />
          {err && <p style={{ color: T.red, fontSize: '0.82rem', margin: 0 }}>{err}</p>}
          <Btn onClick={() => doLogin(username, password)} disabled={!username.trim() || !password || loading}>
            {loading ? <Spinner size={18} color="#fff" /> : '登入 →'}
          </Btn>
        </div>
        <div style={{ border: `2px dashed ${T.accent}`, borderRadius: 16, padding: 16, marginBottom: 16, textAlign: 'center', background: `${T.accent}08` }}>
          <p style={{ fontWeight: 800, margin: '0 0 6px', color: T.dark }}>🎓 老師/評審專用</p>
          <p style={{ fontSize: '0.8rem', color: T.gray, margin: '0 0 12px' }}>示範帳號：<strong>demo</strong> ／ 密碼：<strong>demo1234</strong></p>
          <Btn variant="accent" small disabled={loading} onClick={async () => {
            setLoading(true); setErr('');
            try {
              await ensureDemoAccount();
              const user = await loginUser(DEMO.username, DEMO.password);
              const snap = await get(ref(db, `users/${user.uid}`));
              if (!snap.exists()) throw new Error('no_profile');
              onLogin(user.uid, snap.val().username, snap.val().displayName);
            } catch (e) {
              setErr(e.code === 'auth/operation-not-allowed'
                ? '請先到 Firebase Console → Authentication → Sign-in method → 啟用「電子郵件/密碼」'
                : '示範帳號登入失敗：' + (e.message || e.code));
              setLoading(false);
            }
          }}>
            {loading ? <Spinner size={16} color="#fff" /> : '✨ 一鍵示範帳號登入'}
          </Btn>
        </div>
        <Btn variant="ghost" onClick={onRegister}>還沒有帳號？立即註冊</Btn>
      </div>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN 2 — Register
// ─────────────────────────────────────────────────────────────────
function RegisterScreen({ onSuccess, onBack }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const validate = () => {
    if (username.length < 3) return '使用者名稱至少 3 個字元';
    if (!/^[a-z0-9_]+$/i.test(username)) return '只能包含英文、數字、底線';
    if (password.length < 6) return '密碼至少 6 個字元';
    if (password !== password2) return '兩次密碼不一致';
    return null;
  };

  const handle = async () => {
    const e = validate(); if (e) { setErr(e); return; }
    setLoading(true); setErr('');
    try {
      const user = await registerUser(username, password, displayName || username);
      onSuccess(user.uid, username.toLowerCase(), displayName || username);
    } catch (e2) { setErr(e2.message || '註冊失敗'); setLoading(false); }
  };

  return (
    <Screen>
      <div style={{ padding: '40px 26px' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.gray, fontSize: '0.9rem', marginBottom: 24, fontFamily: 'inherit' }}>← 返回登入</button>
        <h2 style={{ fontSize: '1.6rem', fontWeight: 900, margin: '0 0 6px' }}>建立帳號</h2>
        <p style={{ color: T.gray, margin: '0 0 28px', fontSize: '0.88rem' }}>加入好友、一起決定要吃什麼</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 13, marginBottom: 18 }}>
          <div>
            <label style={{ fontSize: '0.82rem', fontWeight: 700, color: T.gray, marginBottom: 6, display: 'block' }}>使用者名稱（好友搜尋用）</label>
            <input value={username} onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} placeholder="例：alice123" maxLength={16} style={inp} />
            <p style={{ fontSize: '0.75rem', color: T.gray, marginTop: 4 }}>3–16 字元，英文/數字/底線</p>
          </div>
          <div>
            <label style={{ fontSize: '0.82rem', fontWeight: 700, color: T.gray, marginBottom: 6, display: 'block' }}>顯示名稱（可選）</label>
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="例：Alice（可中文）" maxLength={20} style={inp} />
          </div>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="密碼（至少 6 位）" style={inp} />
          <input type="password" value={password2} onChange={e => setPassword2(e.target.value)} placeholder="確認密碼" style={inp} />
          {err && <p style={{ color: T.red, fontSize: '0.82rem', margin: 0 }}>{err}</p>}
          <Btn onClick={handle} disabled={loading}>{loading ? <Spinner size={18} color="#fff" /> : '建立帳號 →'}</Btn>
        </div>
      </div>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN 3 — Home
// ─────────────────────────────────────────────────────────────────
function HomeScreen({ uid, username, displayName, onCreate, onJoin, onFriends, onLogout }) {
  const [joining, setJoining] = useState(false);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [friends, setFriends] = useState([]);
  const [reqCount, setReqCount] = useState(0);
  const [friendsRooms, setFriendsRooms] = useState({});

  useEffect(() => {
    const u1 = onValue(ref(db, `friendRequests/${uid}`), snap => setReqCount(snap.exists() ? Object.keys(snap.val()).length : 0));
    const u2 = onValue(ref(db, `friends/${uid}`), snap => setFriends(snap.exists() ? Object.entries(snap.val()).map(([fuid, d]) => ({ uid: fuid, ...d })) : []));
    return () => { u1(); u2(); };
  }, [uid]);

  useEffect(() => {
    if (!friends.length) { setFriendsRooms({}); return; }
    const rooms = {};
    const unsubs = friends.map(f => onValue(ref(db, `users/${f.uid}/activeRoom`), snap => { rooms[f.uid] = snap.val(); setFriendsRooms({ ...rooms }); }));
    return () => unsubs.forEach(u => u());
  }, [friends]);

  const handleCreate = async () => {
    setLoading(true);
    const roomCode = genCode();
    await Promise.all([
      set(ref(db, `rooms/${roomCode}`), { host: uid, createdBy: uid, created: Date.now(), status: 'waiting', members: { [uid]: { name: displayName || username, ready: false, joined: Date.now() } } }),
      update(ref(db, `users/${uid}`), { activeRoom: roomCode }),
    ]);
    onCreate(roomCode);
    setLoading(false);
  };

  const handleJoin = async () => {
    if (code.length !== 4) return;
    setLoading(true); setErr('');
    try {
      const snap = await get(ref(db, `rooms/${code}`));
      if (!snap.exists()) { setErr('找不到此房間'); setLoading(false); return; }
      const roomData = snap.val();
      if (!['waiting', 'mode', 'searching', 'result_random', 'result_vote', 'result_vote_revealed'].includes(roomData.status)) { setErr('房間已關閉'); setLoading(false); return; }
      await Promise.all([
        update(ref(db, `rooms/${code}/members/${uid}`), { name: displayName || username, ready: false, joined: Date.now() }),
        update(ref(db, `users/${uid}`), { activeRoom: code }),
      ]);
      onJoin(code, roomData.host);
    } catch (e) { setErr(e.message); setLoading(false); }
  };

  return (
    <Screen>
      <div style={{ padding: '28px 22px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <div>
            <p style={{ margin: 0, color: T.gray, fontSize: '0.8rem' }}>歡迎回來</p>
            <h2 style={{ margin: '2px 0 0', fontSize: '1.35rem', fontWeight: 900 }}>{displayName || username} 👋</h2>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button onClick={onFriends} style={{ position: 'relative', background: T.lightBg, border: `1.5px solid ${T.border}`, borderRadius: 12, padding: '8px 14px', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.85rem', fontWeight: 700, color: T.dark }}>
              👥 好友
              {reqCount > 0 && <span style={{ position: 'absolute', top: -6, right: -6, background: T.red, color: '#fff', borderRadius: '50%', width: 18, height: 18, fontSize: '0.7rem', fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{reqCount}</span>}
            </button>
            <button onClick={onLogout} style={{ background: 'none', border: `1.5px solid ${T.border}`, borderRadius: 12, padding: '8px 12px', cursor: 'pointer', color: T.gray, fontFamily: 'inherit' }}>登出</button>
          </div>
        </div>
        <Card sx={{ background: `linear-gradient(150deg,${T.primary},${T.primaryD})`, border: 'none', marginBottom: 20, boxShadow: `0 8px 30px ${T.primary}40` }}>
          <div style={{ textAlign: 'center', padding: '6px 0' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: 6 }}>🍽️</div>
            <h2 style={{ color: '#fff', margin: '0 0 6px', fontSize: '1.25rem', fontWeight: 900 }}>今天想吃什麼？</h2>
            <p style={{ color: 'rgba(255,255,255,0.75)', margin: 0, fontSize: '0.83rem' }}>邀請好友一起，讓 Google Maps 幫你們選</p>
          </div>
        </Card>
        {!joining ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
            <Btn onClick={handleCreate} disabled={loading} sx={{ padding: '16px' }}>{loading ? <Spinner size={18} color="#fff" /> : '✨ 建立新房間'}</Btn>
            <Btn variant="outline" onClick={() => setJoining(true)} sx={{ padding: '16px' }}>🚪 加入房間</Btn>
          </div>
        ) : (
          <Card sx={{ marginBottom: 24 }}>
            <p style={{ margin: '0 0 12px', fontWeight: 800 }}>輸入房間號碼</p>
            <input value={code} onChange={e => { setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')); setErr(''); }} placeholder="A3B7" maxLength={4} style={{ ...inp, fontSize: '2rem', fontWeight: 900, textAlign: 'center', letterSpacing: '10px', fontFamily: 'monospace', marginBottom: 12 }} />
            {err && <p style={{ color: T.red, fontSize: '0.82rem', marginBottom: 10 }}>{err}</p>}
            <div style={{ display: 'flex', gap: 10 }}>
              <Btn variant="ghost" onClick={() => { setJoining(false); setCode(''); }} sx={{ flex: 1 }}>取消</Btn>
              <Btn onClick={handleJoin} disabled={code.length !== 4 || loading} sx={{ flex: 2 }}>{loading ? <Spinner size={16} color="#fff" /> : '加入 →'}</Btn>
            </div>
          </Card>
        )}
        {friends.length > 0 && (
          <div>
            <p style={{ fontWeight: 800, fontSize: '0.9rem', color: T.gray, margin: '0 0 12px' }}>👥 好友動態</p>
            {friends.map(f => {
              const activeRoom = friendsRooms[f.uid];
              return (
                <Card key={f.uid} sx={{ marginBottom: 10, padding: '14px 18px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '0.92rem' }}>@{f.username}</div>
                      <div style={{ fontSize: '0.76rem', color: activeRoom ? T.green : T.gray, marginTop: 2 }}>{activeRoom ? `🏠 在房間 ${activeRoom}` : '無活躍房間'}</div>
                    </div>
                    {activeRoom && (
                      <button onClick={async () => {
                        setLoading(true);
                        try {
                          const snap = await get(ref(db, `rooms/${activeRoom}`));
                          const hostUid = snap.val()?.host;
                          await Promise.all([update(ref(db, `rooms/${activeRoom}/members/${uid}`), { name: displayName || username, ready: false, joined: Date.now() }), update(ref(db, `users/${uid}`), { activeRoom })]);
                          onJoin(activeRoom, hostUid);
                        } catch (e) { alert(e.message); }
                        setLoading(false);
                      }} style={{ background: `${T.green}15`, border: `1.5px solid ${T.green}`, borderRadius: 10, padding: '6px 14px', cursor: 'pointer', color: T.green, fontWeight: 700, fontSize: '0.82rem', fontFamily: 'inherit' }}>加入</button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
        {friends.length === 0 && <Card sx={{ textAlign: 'center', padding: '20px', background: T.lightBg, border: 'none' }}><p style={{ margin: 0, color: T.gray, fontSize: '0.85rem' }}>還沒有好友！點上方「好友」按鈕來搜尋加好友 👆</p></Card>}
      </div>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN 4 — Friends
// ─────────────────────────────────────────────────────────────────
function FriendsScreen({ uid, username, onBack }) {
  const [tab, setTab] = useState('list');
  const [friends, setFriends] = useState([]);
  const [requests, setRequests] = useState([]);
  const [searchQ, setSearchQ] = useState('');
  const [searchResult, setSearchResult] = useState(null);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const u1 = onValue(ref(db, `friends/${uid}`), snap => setFriends(snap.exists() ? Object.entries(snap.val()).map(([fuid, d]) => ({ uid: fuid, ...d })) : []));
    const u2 = onValue(ref(db, `friendRequests/${uid}`), snap => setRequests(snap.exists() ? Object.entries(snap.val()).map(([fromUid, d]) => ({ uid: fromUid, ...d })) : []));
    return () => { u1(); u2(); };
  }, [uid]);

  const handleSearch = async () => {
    if (!searchQ.trim()) return;
    setSearching(true); setSearchResult(null); setMsg('');
    const result = await findUserByUsername(searchQ.trim());
    setSearchResult(result || 'not_found'); setSearching(false);
  };
  const handleSendReq = async (toUser) => {
    setLoading(true);
    if (friends.some(f => f.uid === toUser.uid)) { setMsg('已經是好友了！'); setLoading(false); return; }
    if (toUser.uid === uid) { setMsg('不能加自己為好友 😄'); setLoading(false); return; }
    await sendFriendReq(uid, username, toUser.uid);
    setMsg(`好友請求已送出給 @${toUser.username}！`); setSearchResult(null); setSearchQ(''); setLoading(false);
  };
  const handleAccept = async (req) => { setLoading(true); await acceptFriendReq(uid, username, req.uid, req.fromUsername); setLoading(false); };
  const handleDecline = async (req) => { setLoading(true); await declineFriendReq(uid, req.uid); setLoading(false); };

  const tabs = [{ id: 'list', label: `好友 (${friends.length})` }, { id: 'requests', label: `請求${requests.length > 0 ? ` (${requests.length})` : ''}`, badge: requests.length }, { id: 'search', label: '🔍 搜尋' }];

  return (
    <Screen>
      <div style={{ padding: '24px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22 }}>
          <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.gray, fontSize: '1.2rem', padding: 4 }}>←</button>
          <h2 style={{ margin: 0, fontSize: '1.3rem', fontWeight: 900 }}>好友管理</h2>
        </div>
        <div style={{ display: 'flex', background: T.border, borderRadius: 14, padding: 4, marginBottom: 20 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => { setTab(t.id); setMsg(''); }} style={{ flex: 1, padding: '10px 4px', borderRadius: 12, border: 'none', background: tab === t.id ? '#fff' : 'transparent', color: tab === t.id ? T.primary : T.gray, fontWeight: 800, fontFamily: "'Noto Sans TC',sans-serif", cursor: 'pointer', fontSize: '0.82rem', boxShadow: tab === t.id ? '0 2px 10px rgba(0,0,0,0.07)' : 'none', position: 'relative', transition: 'all 0.2s' }}>
              {t.label}
              {t.badge > 0 && tab !== t.id && <span style={{ position: 'absolute', top: 2, right: 2, background: T.red, color: '#fff', borderRadius: '50%', width: 14, height: 14, fontSize: '0.6rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{t.badge}</span>}
            </button>
          ))}
        </div>
        {msg && <div style={{ background: `${T.green}15`, border: `1px solid ${T.green}`, borderRadius: 12, padding: '10px 16px', marginBottom: 16, fontSize: '0.85rem', color: T.green, fontWeight: 600 }}>✓ {msg}</div>}
        {tab === 'list' && (friends.length === 0 ? <Card sx={{ textAlign: 'center', padding: 28 }}><div style={{ fontSize: '2.5rem', marginBottom: 10 }}>👥</div><p style={{ color: T.gray, margin: 0 }}>還沒有好友，去搜尋加好友吧！</p></Card> : friends.map(f => (
          <Card key={f.uid} sx={{ marginBottom: 12, padding: '14px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: '50%', background: `linear-gradient(135deg,${T.primary},${T.accent})`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 900, fontSize: '1.1rem' }}>{f.username[0].toUpperCase()}</div>
              <div><div style={{ fontWeight: 700 }}>@{f.username}</div><div style={{ fontSize: '0.75rem', color: T.gray }}>好友</div></div>
            </div>
          </Card>
        )))}
        {tab === 'requests' && (requests.length === 0 ? <Card sx={{ textAlign: 'center', padding: 28 }}><div style={{ fontSize: '2.5rem', marginBottom: 10 }}>📭</div><p style={{ color: T.gray, margin: 0 }}>沒有待處理的好友請求</p></Card> : requests.map(req => (
          <Card key={req.uid} sx={{ marginBottom: 12, padding: '16px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div><div style={{ fontWeight: 700 }}>@{req.fromUsername}</div><div style={{ fontSize: '0.75rem', color: T.gray }}>想加你為好友</div></div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => handleAccept(req)} disabled={loading} style={{ background: T.green, color: '#fff', border: 'none', borderRadius: 10, padding: '7px 14px', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit', fontSize: '0.82rem' }}>接受</button>
                <button onClick={() => handleDecline(req)} disabled={loading} style={{ background: T.lightBg, color: T.gray, border: `1.5px solid ${T.border}`, borderRadius: 10, padding: '7px 14px', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.82rem' }}>拒絕</button>
              </div>
            </div>
          </Card>
        )))}
        {tab === 'search' && (
          <div>
            <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
              <input value={searchQ} onChange={e => setSearchQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()} placeholder="輸入使用者名稱搜尋" style={{ ...inp, flex: 1, margin: 0 }} />
              <button onClick={handleSearch} disabled={searching || !searchQ.trim()} style={{ background: T.primary, color: '#fff', border: 'none', borderRadius: 14, padding: '0 20px', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit' }}>{searching ? <Spinner size={16} color="#fff" /> : '搜尋'}</button>
            </div>
            {searchResult === 'not_found' && <Card sx={{ textAlign: 'center', padding: 24 }}><p style={{ color: T.gray, margin: 0 }}>找不到使用者「{searchQ}」</p></Card>}
            {searchResult && searchResult !== 'not_found' && (
              <Card sx={{ padding: '16px 18px', animation: 'slideUp 0.3s ease' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 44, height: 44, borderRadius: '50%', background: `linear-gradient(135deg,${T.primary},${T.accent})`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 900, fontSize: '1.1rem' }}>{searchResult.username[0].toUpperCase()}</div>
                    <div><div style={{ fontWeight: 800 }}>@{searchResult.username}</div><div style={{ fontSize: '0.76rem', color: T.gray }}>{searchResult.displayName}</div></div>
                  </div>
                  <button onClick={() => handleSendReq(searchResult)} disabled={loading} style={{ background: `${T.primary}15`, color: T.primary, border: `1.5px solid ${T.primary}`, borderRadius: 10, padding: '7px 14px', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit', fontSize: '0.82rem' }}>
                    {loading ? <Spinner size={14} color={T.primary} /> : '＋ 加好友'}
                  </button>
                </div>
              </Card>
            )}
          </div>
        )}
      </div>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN 5 — Lobby
// ─────────────────────────────────────────────────────────────────
function MemberMap({ members, myLoc }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  useEffect(() => {
    loadMaps().then(() => {
      if (!divRef.current || mapRef.current) return;
      mapRef.current = new window.google.maps.Map(divRef.current, { center: myLoc || { lat: 22.9908, lng: 120.2133 }, zoom: 15, disableDefaultUI: true, styles: [{ featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] }] });
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!mapRef.current) return;
    markersRef.current.forEach(m => m.setMap(null)); markersRef.current = [];
    const valid = Object.values(members).filter(m => m.lat && m.lng);
    valid.forEach(m => {
      const marker = new window.google.maps.Marker({ position: { lat: m.lat, lng: m.lng }, map: mapRef.current, title: m.name, label: { text: m.name[0], color: '#fff', fontWeight: 'bold' }, icon: { path: window.google.maps.SymbolPath.CIRCLE, scale: 16, fillColor: m.ready ? T.green : T.primary, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 } });
      markersRef.current.push(marker);
    });
    if (valid.length > 1) { const bounds = new window.google.maps.LatLngBounds(); valid.forEach(m => bounds.extend({ lat: m.lat, lng: m.lng })); mapRef.current.fitBounds(bounds, 60); }
  }, [members]);
  return <div ref={divRef} style={{ width: '100%', height: 190, borderRadius: 16, overflow: 'hidden', background: '#E8F4FE', border: `1px solid ${T.border}` }} />;
}

function LobbyScreen({ uid, displayName, username, roomCode, isHost, onProceed, onLeave }) {
  const [members, setMembers] = useState({});
  const [myDist, setMyDist] = useState(2);
  const [myBudget, setMyBudget] = useState(300);
  const [myReady, setMyReady] = useState(false);
  const [myLoc, setMyLoc] = useState(null);
  const [locStatus, setLocStatus] = useState('loading');
  const [copied, setCopied] = useState(false);
  const [mapsLoaded, setMapsLoaded] = useState(false);

  useEffect(() => { loadMaps().then(() => setMapsLoaded(true)).catch(() => {}); }, []);
  useEffect(() => {
    setLocStatus('loading');
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      const loc = { lat: coords.latitude, lng: coords.longitude };
      setMyLoc(loc); setLocStatus('ok');
      update(ref(db, `rooms/${roomCode}/members/${uid}`), { lat: loc.lat, lng: loc.lng });
    }, () => setLocStatus('err'), { enableHighAccuracy: true, timeout: 10000 });
  }, []);
  useEffect(() => {
    const unsub = onValue(ref(db, `rooms/${roomCode}/members`), snap => setMembers(snap.val() || {}));
    return () => unsub();
  }, [roomCode]);

  const memberList = Object.entries(members).map(([id, d]) => ({ id, ...d }));
  const allReady = memberList.length > 0 && memberList.every(m => m.ready);
  const readyCount = memberList.filter(m => m.ready).length;

  const handleReady = async () => {
    await update(ref(db, `rooms/${roomCode}/members/${uid}`), { distance: myDist, budget: myBudget, ready: true });
    setMyReady(true);
  };
  const handleStart = async () => {
    // 更新 Firebase 狀態 → 所有成員會自動跳轉到 mode 畫面
    await update(ref(db, `rooms/${roomCode}`), { status: 'mode', isRetry: false });
    onProceed(memberList);
  };
  const handleCopy = () => { navigator.clipboard?.writeText(roomCode).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const sliderSx = { width: '100%', height: 4 };
  const locColors = { ok: T.green, err: T.red, loading: T.primary };

  return (
    <Screen>
      <div style={{ padding: '20px 20px 36px' }}>
        <Card sx={{ marginBottom: 14, padding: '14px 18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <p style={{ margin: 0, color: T.gray, fontSize: '0.78rem' }}>房間號碼</p>
              <span style={{ fontFamily: 'monospace', fontSize: '2rem', fontWeight: 900, color: T.primary, letterSpacing: '6px' }}>{roomCode}</span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <button onClick={handleCopy} style={{ background: copied ? T.greenLight : `${T.primary}18`, border: 'none', borderRadius: 10, padding: '8px 14px', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 700, color: copied ? T.green : T.primary, fontFamily: 'inherit', transition: 'all 0.2s' }}>{copied ? '✓ 已複製' : '複製'}</button>
              <p style={{ margin: '5px 0 0', color: T.gray, fontSize: '0.75rem' }}>{memberList.length}/6 人</p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 5, marginTop: 10 }}>
            {memberList.map((_, i) => <div key={i} style={{ flex: 1, height: 5, borderRadius: 4, background: i < readyCount ? T.green : T.border, transition: 'background 0.4s' }} />)}
          </div>
        </Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, padding: '10px 16px', borderRadius: 12, background: locStatus === 'ok' ? T.greenLight : locStatus === 'err' ? '#FFE8EA' : T.lightBg, border: `1px solid ${locColors[locStatus] || T.border}` }}>
          {locStatus === 'loading' && <Spinner size={14} color={T.primary} />}
          <span style={{ fontSize: '0.82rem', fontWeight: 600, color: locColors[locStatus] || T.gray }}>
            {locStatus === 'loading' && '取得 GPS 位置中…'}
            {locStatus === 'ok' && '📍 已取得位置'}
            {locStatus === 'err' && '⚠️ 無法取得位置，請允許定位權限'}
          </span>
        </div>
        {mapsLoaded && <div style={{ marginBottom: 14 }}><MemberMap members={members} myLoc={myLoc} /></div>}
        <Card sx={{ marginBottom: 14 }}>
          <p style={{ margin: '0 0 12px', fontWeight: 800, fontSize: '0.9rem', color: T.gray }}>🧑‍🤝‍🧑 成員</p>
          {memberList.map((m, i) => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: i < memberList.length - 1 ? `1px solid ${T.border}` : 'none' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: '0.92rem' }}>
                  {m.name}
                  {m.id === uid && <span style={{ color: T.primary, fontSize: '0.74rem', marginLeft: 5 }}>(你)</span>}
                  {m.id === memberList.find(x => x.id)?.id && <HostBadge />}
                </div>
                {m.ready && <div style={{ fontSize: '0.72rem', color: T.gray, marginTop: 1 }}>📍 {m.distance}km · 💰 NT${m.budget}</div>}
              </div>
              <span style={{ padding: '4px 13px', borderRadius: 20, fontSize: '0.77rem', fontWeight: 700, background: m.ready ? T.greenLight : T.lightBg, color: m.ready ? T.green : T.gray }}>{m.ready ? '✓ 準備好' : '等待中'}</span>
            </div>
          ))}
        </Card>
        {!myReady && (
          <Card sx={{ marginBottom: 14 }}>
            <p style={{ margin: '0 0 16px', fontWeight: 800, fontSize: '0.9rem', color: T.gray }}>⚙️ 我的設定</p>
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}><label style={{ fontWeight: 700, fontSize: '0.88rem' }}>🚶 可移動距離</label><span style={{ fontWeight: 900, color: T.primary }}>{myDist} km</span></div>
              <input type="range" min={0.3} max={10} step={0.2} value={myDist} onChange={e => setMyDist(+e.target.value)} style={sliderSx} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: T.gray, marginTop: 4 }}><span>300m</span><span>10 km</span></div>
            </div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}><label style={{ fontWeight: 700, fontSize: '0.88rem' }}>💰 這餐預算</label><span style={{ fontWeight: 900, color: T.primary }}>NT${myBudget}</span></div>
              <input type="range" min={50} max={1200} step={50} value={myBudget} onChange={e => setMyBudget(+e.target.value)} style={sliderSx} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: T.gray, marginTop: 4 }}><span>NT$50</span><span>NT$1200</span></div>
            </div>
            <Btn onClick={handleReady}>✅ 我準備好了！</Btn>
          </Card>
        )}
        {myReady && !allReady && (
          <Card sx={{ textAlign: 'center', marginBottom: 14 }}>
            <div style={{ fontSize: '2rem', marginBottom: 6, animation: 'pulse 1.5s ease infinite' }}>⏳</div>
            <p style={{ fontWeight: 800, margin: '0 0 4px' }}>等待其他人準備中…</p>
            <p style={{ color: T.gray, fontSize: '0.83rem', margin: 0 }}>分享號碼 <strong style={{ color: T.primary }}>{roomCode}</strong></p>
          </Card>
        )}
        {allReady && (
          <Card sx={{ textAlign: 'center', background: `linear-gradient(150deg,${T.green},#2D6A4F)`, border: 'none', boxShadow: `0 8px 28px ${T.green}50`, animation: 'pop 0.5s cubic-bezier(0.34,1.56,0.64,1)' }}>
            <div style={{ fontSize: '2rem', marginBottom: 10 }}>🎉</div>
            <p style={{ color: '#fff', fontWeight: 800, margin: '0 0 14px' }}>所有人都準備好了！</p>
            {isHost
              ? <Btn variant="accent" onClick={handleStart} sx={{ padding: '15px' }}>🗺️ 開始找餐廳！</Btn>
              : <p style={{ color: 'rgba(255,255,255,0.8)', margin: 0, fontSize: '0.88rem' }}>等待房主開始…</p>
            }
          </Card>
        )}
        <button onClick={onLeave} style={{ width: '100%', marginTop: 16, background: 'none', border: 'none', cursor: 'pointer', color: T.gray, fontSize: '0.82rem', fontFamily: 'inherit' }}>離開房間</button>
      </div>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN 6 — Mode Select（非房主只能等待）
// ─────────────────────────────────────────────────────────────────
function ModeScreen({ onMode, isRetry, isHost }) {
  if (!isHost) {
    return (
      <Screen>
        <div style={{ padding: '80px 28px', textAlign: 'center' }}>
          <div style={{ fontSize: '3rem', marginBottom: 20, animation: 'pulse 1.5s ease-in-out infinite' }}>🍽️</div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 900, margin: '0 0 10px' }}>等待房主選擇模式</h2>
          <p style={{ color: T.gray, fontSize: '0.88rem' }}>房主正在決定要隨機還是投票…</p>
        </div>
      </Screen>
    );
  }
  return (
    <Screen>
      <div style={{ padding: '56px 24px', textAlign: 'center' }}>
        <div style={{ fontSize: '3rem', marginBottom: 14 }}>{isRetry ? '🔄' : '🎯'}</div>
        <h2 style={{ fontSize: '1.5rem', fontWeight: 900, margin: '0 0 8px' }}>{isRetry ? '再試一次！' : '選擇決定方式'}</h2>
        <p style={{ color: T.gray, margin: '0 0 36px', fontSize: '0.88rem' }}>{isRetry ? '換個方式重新決定' : '你們想怎麼決定今天吃什麼？'}</p>
        {[
          { mode: 'random', emoji: '🎲', title: '隨機選擇', desc: '讓命運來決定！從符合條件的餐廳中隨機挑一間', accent: false },
          { mode: 'vote',   emoji: '🗳️', title: '投票決定', desc: '列出所有符合的餐廳，大家投票選出最高票', accent: true },
        ].map(({ mode, emoji, title, desc, accent }) => (
          <button key={mode} onClick={() => onMode(mode)} style={{ display: 'block', width: '100%', marginBottom: 16, padding: 22, borderRadius: 24, textAlign: 'left', cursor: 'pointer', border: `2px solid ${accent ? T.primary : T.border}`, background: accent ? `${T.primary}08` : '#fff', boxShadow: accent ? `0 6px 24px ${T.primary}25` : '0 2px 12px rgba(0,0,0,0.04)', fontFamily: "'Noto Sans TC',sans-serif", transition: 'all 0.2s' }}>
            <div style={{ fontSize: '2.2rem', marginBottom: 8 }}>{emoji}</div>
            <h3 style={{ margin: '0 0 6px', fontSize: '1.1rem', fontWeight: 900, color: T.dark }}>{title}</h3>
            <p style={{ margin: 0, color: T.gray, fontSize: '0.83rem', lineHeight: 1.6 }}>{desc}</p>
          </button>
        ))}
      </div>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN 7 — Searching（只有房主實際搜尋，成員看動畫等待）
// ─────────────────────────────────────────────────────────────────
function SearchingScreen({ memberList, roomCode, mode, onDone, isHost }) {
  const [step, setStep] = useState(0);
  const [err, setErr] = useState('');
  const steps = ['📍 計算各成員位置…', '🗺️ 計算搜尋範圍…', '🔍 搜尋 Google Maps 餐廳…', '💰 篩選預算條件…', '✅ 找到符合的餐廳！'];

  useEffect(() => {
    if (!isHost) {
      // 非房主：播放動畫，等 Firebase 狀態改變後由 App 層導航
      const iv = setInterval(() => setStep(s => Math.min(s + 0.5, steps.length - 2)), 800);
      return () => clearInterval(iv);
    }
    // 房主：實際執行搜尋
    const run = async () => {
      try {
        await loadMaps(); setStep(1);
        const located = memberList.filter(m => m.lat && m.lng);
        const locs = located.length > 0 ? located.map(m => ({ lat: m.lat, lng: m.lng })) : [{ lat: 22.9908, lng: 120.2133 }];
        setStep(2);
        const center = centerOf(locs);
        const ready = memberList.filter(m => m.ready);
        const radius = Math.min(...ready.map(m => m.distance ?? 2));
        const budget = Math.min(...ready.map(m => m.budget ?? 300));
        setStep(3); await new Promise(r => setTimeout(r, 600));
        const restaurants = await searchRestaurants(center, radius, budget);
        setStep(4);
        if (mode === 'random') {
          const pick = restaurants[Math.floor(Math.random() * restaurants.length)] ?? null;
          // 同步狀態到 Firebase，所有成員一起看到結果
          await update(ref(db, `rooms/${roomCode}`), { status: 'result_random', restaurants, randomPickId: pick?.id ?? null });
          onDone(restaurants, pick);
        } else {
          await update(ref(db, `rooms/${roomCode}`), { status: 'result_vote', restaurants });
          onDone(restaurants, null);
        }
      } catch (e) { setErr('搜尋失敗：' + (e.message || '請確認 API 金鑰')); }
    };
    run();
  }, [isHost]);

  return (
    <Screen>
      <div style={{ padding: '80px 28px', textAlign: 'center' }}>
        {err ? (
          <Card sx={{ textAlign: 'center' }}><div style={{ fontSize: '2.5rem', marginBottom: 12 }}>⚠️</div><p style={{ fontWeight: 800 }}>搜尋失敗</p><p style={{ color: T.gray, fontSize: '0.85rem' }}>{err}</p></Card>
        ) : (
          <>
            <div style={{ fontSize: '3.5rem', marginBottom: 20, display: 'inline-block', animation: 'spin 2.5s linear infinite' }}>🔍</div>
            <h2 style={{ fontSize: '1.4rem', fontWeight: 900, margin: '0 0 10px' }}>{isHost ? '搜尋中…' : '等待搜尋結果…'}</h2>
            <p style={{ color: T.gray, margin: '0 0 28px', fontSize: '0.9rem' }}>{steps[Math.min(Math.floor(step), steps.length - 1)]}</p>
            <div style={{ background: T.border, borderRadius: 20, height: 12, overflow: 'hidden', marginBottom: 8 }}>
              <div style={{ height: '100%', borderRadius: 20, background: `linear-gradient(90deg,${T.primary},${T.accent})`, width: `${(step / steps.length) * 100}%`, transition: 'width 0.5s ease' }} />
            </div>
            <div style={{ marginTop: 36, display: 'flex', justifyContent: 'center', gap: 14, fontSize: '1.7rem' }}>
              {['🍜', '🍕', '🌮', '🍣', '🥗'].map((e, i) => <span key={i} style={{ display: 'inline-block', animation: `bounce 1.2s ${i * 0.18}s ease-in-out infinite` }}>{e}</span>)}
            </div>
          </>
        )}
      </div>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN 8 — Random Result（只有房主能重選）
// ─────────────────────────────────────────────────────────────────
function RandomResultScreen({ restaurant, restaurants, roomCode, uid, onRePickSame, onRetryMode, onHome }) {
  const [show, setShow] = useState(false);
  // 直接從 Firebase 取得房主，不依賴 props
  const [hostUid, setHostUid] = useState('');
  const isHost = !!uid && !!hostUid && uid === hostUid;

  useEffect(() => {
    const unsub = onValue(ref(db, `rooms/${roomCode}/host`), snap => setHostUid(snap.val() || ''));
    return () => unsub();
  }, [roomCode]);

  useEffect(() => { setTimeout(() => setShow(true), 300); }, [restaurant]);

  const confetti = Array.from({ length: 20 }, (_, i) => ({ x: (i * 43) % 100, delay: i * 0.07, color: [T.primary, T.accent, T.green, T.red][i % 4], dur: 1.2 + ((i * 31) % 10) * 0.15 }));

  if (!restaurant) return (
    <Screen><div style={{ padding: '80px 24px', textAlign: 'center' }}>
      <p style={{ color: T.gray }}>沒有找到符合條件的餐廳</p>
      {isHost && <Btn onClick={onRetryMode} sx={{ marginTop: 24 }}>重新選擇條件</Btn>}
    </div></Screen>
  );

  return (
    <Screen>
      <div style={{ padding: '28px 24px', textAlign: 'center' }}>
        <p style={{ color: T.gray, margin: '0 0 4px', fontSize: '0.88rem' }}>🎲 命運選擇了</p>
        <h2 style={{ fontSize: '1.3rem', fontWeight: 900, margin: '0 0 24px' }}>今天就吃這間！</h2>
        {show && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 10 }}>
            {confetti.map((c, i) => <div key={i} style={{ position: 'absolute', left: `${c.x}%`, top: '-20px', width: 10, height: 10, borderRadius: i % 3 === 0 ? 0 : '50%', background: c.color, animation: `fall ${c.dur}s ${c.delay}s ease-in forwards` }} />)}
          </div>
        )}
        <Card sx={{ marginBottom: 20, transform: show ? 'scale(1)' : 'scale(0.7)', opacity: show ? 1 : 0, transition: 'all 0.55s cubic-bezier(0.34,1.56,0.64,1)', border: `2px solid ${T.primary}`, boxShadow: `0 12px 40px ${T.primary}30` }}>
          {restaurant.photo ? <img src={restaurant.photo} alt={restaurant.name} style={{ width: '100%', height: 155, objectFit: 'cover', borderRadius: 12, marginBottom: 14 }} /> : <div style={{ fontSize: '4.5rem', marginBottom: 12, animation: show ? 'bounce 2s ease-in-out infinite' : 'none' }}>🍽️</div>}
          <h1 style={{ fontSize: '1.6rem', fontWeight: 900, margin: '0 0 6px' }}>{restaurant.name}</h1>
          <p style={{ color: T.gray, fontSize: '0.82rem', margin: '0 0 12px' }}>{restaurant.address}</p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 24 }}>
            <div style={{ textAlign: 'center' }}><Stars r={restaurant.rating} /><div style={{ color: T.gray, fontSize: '0.7rem', marginTop: 2 }}>{restaurant.reviews.toLocaleString()} 評論</div></div>
            <div style={{ textAlign: 'center' }}><span style={{ color: T.green, fontWeight: 700 }}>{'$'.repeat(restaurant.priceLevel || 2)}</span><div style={{ color: T.gray, fontSize: '0.7rem', marginTop: 2 }}>價位</div></div>
          </div>
        </Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Btn variant="green" onClick={() => window.open(restaurant.mapsUrl, '_blank')}>🗺️ 在 Google Maps 開啟</Btn>
          {/* 只有房主能看到重選按鈕 */}
          {isHost && (
            <div style={{ background: T.lightBg, borderRadius: 16, padding: 16 }}>
              <p style={{ fontWeight: 800, margin: '0 0 12px', fontSize: '0.88rem', textAlign: 'center', color: T.gray }}>😕 不滿意這間？（房主控制）</p>
              <div style={{ display: 'flex', gap: 10 }}>
                <Btn variant="outline" small onClick={onRePickSame} sx={{ flex: 1 }}>🎲 重新隨機</Btn>
                <Btn variant="ghost" small onClick={onRetryMode} sx={{ flex: 1 }}>🔄 換個模式</Btn>
              </div>
            </div>
          )}
          {!isHost && (
            <div style={{ background: T.lightBg, borderRadius: 12, padding: '12px 16px', textAlign: 'center' }}>
              <p style={{ margin: 0, color: T.gray, fontSize: '0.83rem' }}>不滿意？請請求房主重新選擇</p>
            </div>
          )}
          <Btn variant="ghost" onClick={onHome} sx={{ padding: '11px' }}>↩ 回首頁</Btn>
        </div>
      </div>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN 9 — Vote（只有房主能揭曉與重投，結果全員同步）
// ─────────────────────────────────────────────────────────────────
function VoteScreen({ uid, restaurants, roomCode, onRetryMode, onHome }) {
  const [myVote, setMyVote] = useState(null);
  const [votes, setVotes] = useState({});
  const [revealed, setRevealed] = useState(false);
  // 直接從 Firebase 取得房主，不依賴 props，確保準確
  const [hostUid, setHostUid] = useState('');
  const isHost = !!uid && !!hostUid && uid === hostUid;

  useEffect(() => {
    const u1 = onValue(ref(db, `rooms/${roomCode}/votes`), snap => setVotes(snap.val() || {}));
    const u2 = onValue(ref(db, `rooms/${roomCode}/status`), snap => {
      const status = snap.val();
      if (status === 'result_vote_revealed') setRevealed(true);
      if (status === 'result_vote') { setRevealed(false); setMyVote(null); }
    });
    // 直接監聽 Firebase 的 host 欄位
    const u3 = onValue(ref(db, `rooms/${roomCode}/host`), snap => setHostUid(snap.val() || ''));
    return () => { u1(); u2(); u3(); };
  }, [roomCode]);

  const handleVote = async (id) => {
    if (myVote || revealed) return;
    setMyVote(id);
    await set(ref(db, `rooms/${roomCode}/votes/${uid}`), id);
  };

  // 房主揭曉結果 → 同步到 Firebase，全員同步看到
  const handleReveal = async () => {
    await update(ref(db, `rooms/${roomCode}`), { status: 'result_vote_revealed' });
  };

  // 房主重新投票 → 清除票數，全員重置
  const handleRevote = async () => {
    await Promise.all([
      remove(ref(db, `rooms/${roomCode}/votes`)),
      update(ref(db, `rooms/${roomCode}`), { status: 'result_vote' }),
    ]);
  };

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
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: '1.35rem', fontWeight: 900, margin: '0 0 6px' }}>{myVote ? '已投票，等待結果…' : '投票選擇餐廳'}</h2>
              <p style={{ color: T.gray, fontSize: '0.85rem', margin: 0 }}>{myVote ? `目前 ${totalVotes} 票` : '點選你最想吃的'}</p>
            </div>
            {restaurants.map(r => (
              <button key={r.id} onClick={() => handleVote(r.id)} style={{ display: 'block', width: '100%', marginBottom: 12, padding: '15px 18px', borderRadius: 18, textAlign: 'left', border: `2px solid ${myVote === r.id ? T.primary : T.border}`, background: myVote === r.id ? `${T.primary}10` : '#fff', cursor: myVote ? 'default' : 'pointer', transform: myVote === r.id ? 'scale(1.015)' : 'scale(1)', boxShadow: myVote === r.id ? `0 4px 18px ${T.primary}30` : 'none', fontFamily: "'Noto Sans TC',sans-serif", transition: 'all 0.22s' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {r.photo ? <img src={r.photo} style={{ width: 50, height: 50, borderRadius: 10, objectFit: 'cover' }} /> : <div style={{ width: 50, height: 50, borderRadius: 10, background: T.lightBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.6rem' }}>🍽️</div>}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: 3 }}>{r.name}</div>
                    <div style={{ color: T.gray, fontSize: '0.76rem' }}><Stars r={r.rating} /></div>
                    <div style={{ color: T.gray, fontSize: '0.72rem', marginTop: 2 }}>{r.address}</div>
                  </div>
                  {myVote === r.id && <span style={{ fontSize: '1.3rem', color: T.primary }}>✓</span>}
                </div>
              </button>
            ))}
            {/* 只有房主能揭曉和重新投票 */}
            {isHost && myVote && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
                <Btn variant="accent" onClick={handleReveal}>📊 揭曉投票結果（房主）</Btn>
                <Btn variant="ghost" onClick={handleRevote} small>🔄 重新投票（清空所有票）</Btn>
              </div>
            )}
            {!isHost && <p style={{ textAlign: 'center', color: T.gray, fontSize: '0.82rem', marginTop: 16 }}>等待房主揭曉結果…</p>}
          </>
        ) : (
          <>
            <div style={{ textAlign: 'center', marginBottom: 20, animation: 'fadeIn 0.5s ease' }}>
              <div style={{ fontSize: '2.8rem', marginBottom: 8 }}>🏆</div>
              <h2 style={{ fontSize: '1.35rem', fontWeight: 900, margin: '0 0 4px' }}>投票結果揭曉！</h2>
              <p style={{ color: T.gray, margin: 0, fontSize: '0.85rem' }}>共 {totalVotes} 票</p>
            </div>
            {winner && (
              <Card sx={{ marginBottom: 18, textAlign: 'center', background: `${T.primary}10`, border: `2px solid ${T.primary}`, boxShadow: `0 8px 30px ${T.primary}30`, animation: 'pop 0.5s cubic-bezier(0.34,1.56,0.64,1)' }}>
                {winner.photo && <img src={winner.photo} style={{ width: '100%', height: 135, objectFit: 'cover', borderRadius: 12, marginBottom: 12 }} />}
                <h2 style={{ margin: '0 0 6px', fontSize: '1.4rem', fontWeight: 900 }}>{winner.name}</h2>
                <p style={{ color: T.gray, fontSize: '0.82rem', margin: '0 0 8px' }}>{winner.address}</p>
                <div style={{ fontWeight: 900, color: T.primary, fontSize: '1.05rem' }}>🏆 {tally[winner.id] || 0}/{totalVotes} 票</div>
              </Card>
            )}
            {sorted.map((r, i) => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, padding: '12px 16px', borderRadius: 16, background: i === 0 ? T.card : T.lightBg, border: `1.5px solid ${i === 0 ? T.primary : T.border}`, animation: `fadeIn 0.4s ${i * 0.1}s ease both` }}>
                <span style={{ fontWeight: 900, color: i === 0 ? T.primary : T.gray, minWidth: 24 }}>{['🥇', '🥈', '🥉'][i] || `#${i + 1}`}</span>
                <div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{r.name}</div><div style={{ color: T.gray, fontSize: '0.74rem' }}>{r.address}</div></div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 900, color: i === 0 ? T.primary : T.gray }}>{tally[r.id] || 0}票</div>
                  <div style={{ height: 5, borderRadius: 3, background: T.border, width: 60, overflow: 'hidden', marginTop: 4, marginLeft: 'auto' }}>
                    <div style={{ height: '100%', borderRadius: 3, background: i === 0 ? T.primary : T.gray, width: `${totalVotes ? Math.round((tally[r.id] || 0) / totalVotes * 100) : 0}%` }} />
                  </div>
                </div>
              </div>
            ))}
            {/* 只有房主能重投或換模式 */}
            {isHost && (
              <div style={{ background: T.lightBg, borderRadius: 16, padding: 16, marginTop: 16 }}>
                <p style={{ fontWeight: 800, margin: '0 0 12px', fontSize: '0.88rem', textAlign: 'center', color: T.gray }}>😕 不滿意？（房主控制）</p>
                <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                  <Btn variant="outline" small onClick={handleRevote} sx={{ flex: 1 }}>🗳️ 重新投票</Btn>
                  <Btn variant="ghost" small onClick={onRetryMode} sx={{ flex: 1 }}>🔄 換個模式</Btn>
                </div>
                {winner && <Btn variant="green" small onClick={() => window.open(winner.mapsUrl, '_blank')} sx={{ marginBottom: 0 }}>🗺️ Google Maps 導航</Btn>}
              </div>
            )}
            {!isHost && winner && <Btn variant="green" onClick={() => window.open(winner.mapsUrl, '_blank')} sx={{ marginTop: 16 }}>🗺️ Google Maps 導航</Btn>}
            <Btn variant="ghost" onClick={onHome} sx={{ marginTop: 12, padding: '11px' }}>↩ 回首頁</Btn>
          </>
        )}
      </div>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────
// MAIN APP — 包含房間狀態同步監聽器
// ─────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState('loading');
  const [uid, setUid] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [roomHost, setRoomHost] = useState('');         // 房間的房主 uid
  const [mode, setMode] = useState(null);
  const [memberList, setMemberList] = useState([]);
  const [restaurants, setRestaurants] = useState([]);
  const [pick, setPick] = useState(null);
  const [isRetry, setIsRetry] = useState(false);

  const isHost = uid === roomHost;

  // ── 持久化登入 ──────────────────────────────────────────────────
  useEffect(() => {
    ensureDemoAccount();
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (user) {
        try {
          const snap = await get(ref(db, `users/${user.uid}`));
          if (snap.exists()) {
            setUid(user.uid);
            setUsername(snap.val().username);
            setDisplayName(snap.val().displayName || snap.val().username);

            // 離線或關閉網頁時，自動清除 activeRoom
            const activeRoomRef = ref(db, `users/${user.uid}/activeRoom`);
            onDisconnect(activeRoomRef).set(null);

            setScreen('home'); return;
          }
        } catch (_) {}
      }
      setScreen('login');
    });

    // 關閉分頁/重新整理時也清除
    const handleUnload = () => {
      const currentUid = auth.currentUser?.uid;
      if (currentUid) {
        navigator.sendBeacon &&
          update(ref(db, `users/${currentUid}`), { activeRoom: null });
      }
    };
    window.addEventListener('beforeunload', handleUnload);

    return () => { unsub(); window.removeEventListener('beforeunload', handleUnload); };
  }, []);

  // ── 核心：房間狀態同步監聽器（讓所有成員畫面跟著房主走）──────
  useEffect(() => {
    if (!roomCode || !uid) return;

    const unsub = onValue(ref(db, `rooms/${roomCode}`), snap => {
      if (!snap.exists()) return;
      const room = snap.val();
      const amHost = room.host === uid;

      // 非房主跟著 Firebase 狀態導航
      if (!amHost) {
        if (room.status === 'mode') {
          setIsRetry(!!room.isRetry);
          setMemberList(Object.entries(room.members || {}).map(([id, d]) => ({ id, ...d })));
          setScreen('mode');
        } else if (room.status === 'searching') {
          setScreen('searching');
        } else if (room.status === 'result_random') {
          const rests = room.restaurants || [];
          const p = rests.find(r => r.id === room.randomPickId) ?? null;
          setRestaurants(rests);
          setPick(p);
          setScreen('random');
        } else if (room.status === 'result_vote' || room.status === 'result_vote_revealed') {
          setRestaurants(room.restaurants || []);
          setMode('vote');
          setScreen('vote');
        }
      }

      // 房主：當自己重選時，同步更新 pick（以防 Firebase 寫入後回彈）
      if (amHost && room.status === 'result_random' && room.randomPickId) {
        const rests = room.restaurants || [];
        const p = rests.find(r => r.id === room.randomPickId) ?? null;
        if (p && p.id !== pick?.id) setPick(p);
      }
    });

    return () => unsub();
  }, [roomCode, uid]); // 不依賴 screen，避免重複訂閱

  // ── Navigation handlers ──────────────────────────────────────────
  const handleLogin = (firebaseUid, uname, dname) => { setUid(firebaseUid); setUsername(uname); setDisplayName(dname || uname); setScreen('home'); };
  const handleLogout = async () => {
    await signOut(auth);
    if (roomCode) await update(ref(db, `users/${uid}`), { activeRoom: null });
    setUid(''); setUsername(''); setDisplayName(''); setRoomCode(''); setRoomHost('');
    setScreen('login');
  };
  const handleCreate = (code) => { setRoomCode(code); setRoomHost(uid); setIsRetry(false); setScreen('lobby'); };
  const handleJoin = (code, hostUid) => { setRoomCode(code); setRoomHost(hostUid); setIsRetry(false); setScreen('lobby'); };
  const handleLeave = async () => {
    if (roomCode) { await Promise.all([remove(ref(db, `rooms/${roomCode}/members/${uid}`)), update(ref(db, `users/${uid}`), { activeRoom: null })]); }
    setRoomCode(''); setRoomHost(''); setScreen('home');
  };
  const handleProceed = (members) => { setMemberList(members); setScreen('mode'); };

  // 房主選擇模式 → 更新 Firebase，所有成員自動跳到 searching
  const handleMode = async (m) => {
    setMode(m);
    await update(ref(db, `rooms/${roomCode}`), { status: 'searching', isRetry: false });
    setScreen('searching');
  };

  // 搜尋完成（只有房主呼叫）→ Firebase 已在 SearchingScreen 更新
  const handleSearchDone = (results, randomPick) => {
    setRestaurants(results);
    if (randomPick) { setPick(randomPick); setScreen('random'); }
    else { setScreen('vote'); }
  };

  // 重選（同批餐廳）→ 更新 Firebase randomPickId，所有成員同步看到新結果
  const handleRePickSame = async () => {
    const others = restaurants.filter(r => r.id !== pick?.id);
    const pool = others.length > 0 ? others : restaurants;
    const newPick = pool[Math.floor(Math.random() * pool.length)] ?? null;
    setPick(newPick);
    await update(ref(db, `rooms/${roomCode}`), { randomPickId: newPick?.id ?? null, status: 'result_random' });
  };

  // 換模式 → 更新 Firebase，所有人跳回 mode 選擇
  const handleRetryMode = async () => {
    setIsRetry(true);
    await update(ref(db, `rooms/${roomCode}`), { status: 'mode', isRetry: true });
    setScreen('mode');
  };

  const handleHome = async () => {
    await update(ref(db, `users/${uid}`), { activeRoom: null });
    setRoomCode(''); setRoomHost(''); setRestaurants([]); setPick(null); setMode(null); setIsRetry(false);
    setScreen('home');
  };

  if (screen === 'loading') return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#FFFAF4', fontFamily: "'Noto Sans TC',sans-serif" }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '3rem', marginBottom: 12, animation: 'bounce 1.5s ease-in-out infinite' }}>🍽️</div>
        <Spinner size={28} />
      </div>
    </div>
  );

  return (
    <div style={{ background: '#FFF0E0', minHeight: '100vh' }}>
      {screen === 'login'     && <LoginScreen onLogin={handleLogin} onRegister={() => setScreen('register')} />}
      {screen === 'register'  && <RegisterScreen onSuccess={handleLogin} onBack={() => setScreen('login')} />}
      {screen === 'home'      && <HomeScreen uid={uid} username={username} displayName={displayName} onCreate={handleCreate} onJoin={handleJoin} onFriends={() => setScreen('friends')} onLogout={handleLogout} />}
      {screen === 'friends'   && <FriendsScreen uid={uid} username={username} onBack={() => setScreen('home')} />}
      {screen === 'lobby'     && <LobbyScreen uid={uid} username={username} displayName={displayName} roomCode={roomCode} isHost={isHost} onProceed={handleProceed} onLeave={handleLeave} />}
      {screen === 'mode'      && <ModeScreen onMode={handleMode} isRetry={isRetry} isHost={isHost} />}
      {screen === 'searching' && <SearchingScreen memberList={memberList} roomCode={roomCode} mode={mode} onDone={handleSearchDone} isHost={isHost} />}
      {screen === 'random'    && <RandomResultScreen restaurant={pick} restaurants={restaurants} roomCode={roomCode} uid={uid} onRePickSame={handleRePickSame} onRetryMode={handleRetryMode} onHome={handleHome} />}
      {screen === 'vote'      && <VoteScreen uid={uid} restaurants={restaurants} roomCode={roomCode} onRetryMode={handleRetryMode} onHome={handleHome} />}
    </div>
  );
}
