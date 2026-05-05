// Mock data — values match the second reference image exactly so the
// design reads correctly even before being wired to the real backend.

const SIDEBAR_ITEMS = [
  { group: null, items: [
    { id: 'overview',   label: 'Overview',     ico: 'overview' },
    { id: 'mybinder',   label: 'My Binder',    ico: 'binder',     pill: '1,246', active: true },
    { id: 'ghost',      label: 'Ghost Cards',  ico: 'ghost',      pill: '23' },
    { id: 'market',     label: 'Marketplace',  ico: 'market' },
    { id: 'trade',      label: 'Trade Check',  ico: 'trade' },
    { id: 'analytics',  label: 'Analytics',    ico: 'analytics' },
    { id: 'collections',label: 'Collections',  ico: 'collection' },
    { id: 'wishlist',   label: 'Wishlist',     ico: 'wishlist',   pill: '37' },
    { id: 'decks',      label: 'Decks',        ico: 'decks',      pill: '12' }
  ]},
  { group: 'Account', items: [
    { id: 'alerts',     label: 'Alerts',       ico: 'alerts',     pill: '5', alert: true },
    { id: 'messages',   label: 'Messages',     ico: 'message' },
    { id: 'settings',   label: 'Settings',     ico: 'settings' }
  ]}
];

const STATS = [
  { lbl: 'Total Cards',      val: '1,246',    delta: '+18 this week',  primary: false, kind: 'primary' },
  { lbl: 'Collection Value', val: '$12,845.60', delta: '+8.21% · 24h', primary: true },
  { lbl: 'Sets',             val: '328',     delta: '7 nearly complete' },
  { lbl: 'Ghost Cards',      val: '23',      delta: '4 funded' },
  { lbl: 'Cataloged',        val: '97%',     delta: '34 to verify', deltaClass: 'down' }
];

// art swatches — gradient hues per fictional card
const CARDS = [
  { name: 'Vorax, Ironmaw',     rare: 'sr', qty: 'x2', art: 'linear-gradient(180deg,#5e1a0a,#1c0606)', tone: 'flame' },
  { name: 'Nyxshade Assassin',  rare: 'ur', qty: 'x1', art: 'linear-gradient(180deg,#3b0a52,#0a0418)', tone: 'violet' },
  { name: 'Solaris Archon',     rare: 'ur', qty: 'x1', art: 'linear-gradient(180deg,#7a4a08,#1c1004)', tone: 'gold' },
  { name: 'Riftbound Colossus', rare: 'sr', qty: 'x3', art: 'linear-gradient(180deg,#1a3a5e,#04101c)', tone: 'cyan' },
  { name: 'Echo Wisp',          rare: 'cr', qty: 'x4', art: 'linear-gradient(180deg,#0e4a3a,#04140e)', tone: 'mint' },
  { name: 'Crimson Howler',     rare: 'pr', qty: 'x2', art: 'linear-gradient(180deg,#5e0a0a,#1c0404)', tone: 'crimson' },
  { name: 'Gearspark Engineer', rare: 'ur', qty: 'x1', art: 'linear-gradient(180deg,#5a4a14,#180c04)', tone: 'brass' },
  { name: 'Venomtail Dragon',   rare: 'sr', qty: 'x2', art: 'linear-gradient(180deg,#2e4a08,#0a1404)', tone: 'acid' },
  { name: 'Celestial Harp',     rare: 'cr', qty: 'x3', art: 'linear-gradient(180deg,#1a2a4e,#04081c)', tone: 'lapis' },
  { name: 'GHOST CARD',         rare: 'ghost', qty: '1/1', art: 'none' }
];

const RARITY = [
  { code: 'ur', label: 'UR (Ultra Rare)',     n: 112 },
  { code: 'sr', label: 'SR (Super Rare)',     n: 326 },
  { code: 'cr', label: 'CR (Collector Rare)', n: 198 },
  { code: 'pr', label: 'PR (Promo)',          n: 204 },
  { code: 'c',  label: 'C (Common)',          n: 406 }
];

const SUMMARY = [
  { l: 'Collection Value', r: '$12,845.60' },
  { l: 'Cards Tracked',    r: '1,246' },
  { l: 'Avg. Card Value',  r: '$10.31' }
];

const ALERTS = [
  { kind: 'price-up',  ico: 'flame',  iconClass: '',       title: 'Price Spike',     sub: 'Solaris Archon (UR)',    deltaText: '+38% in 24h', deltaClass: 'delta-up' },
  { kind: 'expiring',  ico: 'clock',  iconClass: 'warn',   title: 'Expiring Listing',sub: 'Gearspark Engineer (UR)',deltaText: '23m 1s left', deltaClass: 'delta-warn' },
  { kind: 'offer',     ico: 'trade',  iconClass: 'info',   title: 'Trade Offer',     sub: 'From: NeonCollector',    deltaText: 'Expires in 1h',deltaClass: 'delta-warn' },
  { kind: 'low',       ico: 'warn',   iconClass: 'danger', title: 'Low Stock',       sub: 'Crimson Howler (PR)',    deltaText: 'Only 2 left',  deltaClass: 'delta-dn' },
  { kind: 'market',    ico: 'trend',  iconClass: '',       title: 'Market Update',   sub: '3 sets had price changes',deltaText: 'View more',   deltaClass: 'delta-up' }
];

const MARKET = [
  { name: 'Nyxshade Assassin (UR)',   typ: 'sold',     when: '2m ago',  price: '$124.99', tone: '#3b0a52' },
  { name: 'Riftbound Colossus (SR)',  typ: 'listed',   when: '5m ago',  price: '$49.50',  tone: '#1a3a5e' },
  { name: 'Venomtail Dragon (SR)',    typ: 'sold',     when: '8m ago',  price: '$68.00',  tone: '#2e4a08' },
  { name: 'Celestial Harp (CR)',      typ: 'listed',   when: '12m ago', price: '$29.99',  tone: '#1a2a4e' }
];

window.SIDEBAR_ITEMS = SIDEBAR_ITEMS;
window.STATS = STATS;
window.CARDS = CARDS;
window.RARITY = RARITY;
window.SUMMARY = SUMMARY;
window.ALERTS = ALERTS;
window.MARKET = MARKET;
