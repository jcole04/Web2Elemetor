// Maps reference icons (inline SVG, icon fonts, social links) to the Font
// Awesome Free icons that ship with Elementor, so they become native Icon /
// Icon List / Social Icons widgets instead of code.
import { readFileSync } from 'node:fs';

let FA = null;
function fa() {
  if (!FA) {
    const data = JSON.parse(readFileSync(new URL('../data/fa-icons.json', import.meta.url), 'utf8')).icons;
    FA = { data, names: Object.fromEntries(Object.entries(data).map(([lib, list]) => [lib, new Set(list.map((i) => i[0]))])) };
  }
  return FA;
}

export const LIB = { solid: 'fa-solid', regular: 'fa-regular', brands: 'fa-brands' };
const PREFIX = { solid: 'fas', regular: 'far', brands: 'fab' };

export function faIcon(name, lib = 'solid') {
  // Elementor renders icons as inline SVG and fails on names it does not ship.
  if (!PREFIX[lib] || !hasIcon(name, lib)) return { value: 'fas fa-circle', library: LIB.solid };
  return { value: `${PREFIX[lib]} fa-${name}`, library: LIB[lib] };
}

export function hasIcon(name, lib) {
  return fa().names[lib]?.has(name);
}

// Social networks by link domain or hint word → Font Awesome brand icon.
const BRANDS = [
  [/facebook|fb\.com/, 'facebook-f'], [/(^|[^a-z])x\.com|twitter/, 'twitter'], [/instagram/, 'instagram'], [/linkedin/, 'linkedin-in'],
  [/youtube|youtu\.be/, 'youtube'], [/tiktok/, 'tiktok'], [/github/, 'github'], [/pinterest/, 'pinterest-p'], [/whatsapp|wa\.me/, 'whatsapp'],
  [/dribbble/, 'dribbble'], [/behance/, 'behance'], [/discord/, 'discord'], [/telegram|t\.me/, 'telegram-plane'], [/reddit/, 'reddit-alien'],
  [/medium\.com/, 'medium-m'], [/twitch/, 'twitch'], [/vimeo/, 'vimeo-v'], [/snapchat/, 'snapchat-ghost'], [/spotify/, 'spotify'],
  [/soundcloud/, 'soundcloud'], [/mastodon/, 'mastodon'], [/tumblr/, 'tumblr'], [/skype/, 'skype'], [/slack/, 'slack'],
  [/stackoverflow|stack-overflow/, 'stack-overflow'], [/yelp/, 'yelp'], [/tripadvisor/, 'tripadvisor'], [/etsy/, 'etsy'], [/vk\.com/, 'vk'],
  [/weibo/, 'weibo'], [/xing/, 'xing'], [/flickr/, 'flickr'], [/threads\.net|threads/, 'instagram'], [/bsky|bluesky/, 'cloud'],
  [/apple\.com|app-store|appstore/, 'apple'], [/play\.google|google-play/, 'google-play'], [/google/, 'google'], [/amazon/, 'amazon'],
  [/paypal/, 'paypal'], [/stripe/, 'stripe'], [/wordpress/, 'wordpress'], [/figma/, 'figma'], [/codepen/, 'codepen'],
];

export function brandFor(text) {
  const t = String(text || '').toLowerCase();
  for (const [re, name] of BRANDS) if (re.test(t) && (hasIcon(name, 'brands') || name === 'cloud')) return name === 'cloud' ? faIcon('cloud') : faIcon(name, 'brands');
  if (/\brss\b|feed/.test(t)) return faIcon('rss');
  return null;
}

// Hint words (class names, data-icon, aria-labels, sprite ids) → Font Awesome name.
const SYNONYMS = [
  [/\b(mail|email|envelope|inbox)\b/, 'envelope'], [/\b(phone|call|telephone)\b/, 'phone-alt'], [/\b(map-?pin|location|marker|pin|address|place)\b/, 'map-marker-alt'],
  [/\b(clock|time|schedule|hours?)\b/, 'clock', 'regular'], [/\b(check-?circle|circle-?check|badge-?check)\b/, 'check-circle'], [/\b(check|tick|done|checkmark)\b/, 'check'],
  [/\b(x-?circle|close-?circle)\b/, 'times-circle'], [/\b(close|times|xmark|x)\b/, 'times'], [/\b(menu|hamburger|bars|burger)\b/, 'bars'], [/\b(search|magnifying|magnifier|loupe)\b/, 'search'],
  [/\b(arrow-?up-?right|external|launch|open-in-new)\b/, 'external-link-alt'], [/\b(arrow-?right|arrow-?forward|long-arrow-right)\b/, 'arrow-right'], [/\b(arrow-?left|arrow-?back)\b/, 'arrow-left'],
  [/\b(arrow-?down)\b/, 'arrow-down'], [/\b(arrow-?up)\b/, 'arrow-up'], [/\b(chevron-?right|angle-?right|caret-?right)\b/, 'chevron-right'], [/\b(chevron-?left|angle-?left)\b/, 'chevron-left'],
  [/\b(chevron-?down|angle-?down|caret-?down|expand)\b/, 'chevron-down'], [/\b(chevron-?up|angle-?up)\b/, 'chevron-up'], [/\b(play|play-?circle)\b/, 'play'],
  [/\b(star-?half)\b/, 'star-half-alt'], [/\b(star|rating)\b/, 'star'], [/\b(heart|love|favorite)\b/, 'heart'], [/\b(users|team|group|people)\b/, 'users'], [/\b(user|person|profile|account|avatar)\b/, 'user'],
  [/\b(cart|basket)\b/, 'shopping-cart'], [/\b(bag|shopping)\b/, 'shopping-bag'], [/\b(lock|padlock)\b/, 'lock'], [/\b(shield|secure|security|protect)\b/, 'shield-alt'],
  [/\b(bolt|zap|lightning|flash|fast|speed)\b/, 'bolt'], [/\b(rocket|launch)\b/, 'rocket'], [/\b(line-?chart|trending|trend|growth)\b/, 'chart-line'], [/\b(pie)\b/, 'chart-pie'],
  [/\b(chart|analytics|graph|stats|bar-?chart)\b/, 'chart-bar'], [/\b(cloud)\b/, 'cloud'], [/\b(code|terminal|brackets)\b/, 'code'], [/\b(cog|settings|gear|sliders)\b/, 'cog'],
  [/\b(globe|world|language|earth|international)\b/, 'globe'], [/\b(calendar|date|event)\b/, 'calendar-alt', 'regular'], [/\b(camera)\b/, 'camera'], [/\b(image|photo|picture|gallery)\b/, 'image', 'regular'],
  [/\b(video|film|movie)\b/, 'video'], [/\b(download)\b/, 'download'], [/\b(upload)\b/, 'upload'], [/\b(link|chain)\b/, 'link'], [/\b(share)\b/, 'share-alt'],
  [/\b(quote|quotation|blockquote)\b/, 'quote-left'], [/\b(home|house)\b/, 'home'], [/\b(leaf|eco|plant|nature)\b/, 'leaf'], [/\b(coffee|cafe)\b/, 'coffee'],
  [/\b(utensils|fork|knife|food|restaurant|dining|menu-?book)\b/, 'utensils'], [/\b(wine|glass)\b/, 'wine-glass-alt'], [/\b(plus|add)\b/, 'plus'], [/\b(minus|remove|subtract)\b/, 'minus'],
  [/\b(info)\b/, 'info-circle'], [/\b(help|question)\b/, 'question-circle'], [/\b(warning|alert|exclamation|danger)\b/, 'exclamation-triangle'], [/\b(bell|notification)\b/, 'bell'],
  [/\b(bookmark)\b/, 'bookmark'], [/\b(tag|label|price)\b/, 'tag'], [/\b(gift|present)\b/, 'gift'], [/\b(credit-?card|card|payment|billing)\b/, 'credit-card'],
  [/\b(dollar|money|cash|currency|pricing)\b/, 'dollar-sign'], [/\b(truck|shipping|delivery)\b/, 'truck'], [/\b(headset|support|headphones)\b/, 'headset'],
  [/\b(comments|chats|conversation)\b/, 'comments'], [/\b(comment|chat|message|bubble)\b/, 'comment'], [/\b(send|paper-?plane)\b/, 'paper-plane'],
  [/\b(edit|pencil|pen|write)\b/, 'pen'], [/\b(trash|delete|bin)\b/, 'trash'], [/\b(eye|view|visible)\b/, 'eye'], [/\b(filter|funnel)\b/, 'filter'],
  [/\b(layers|stack)\b/, 'layer-group'], [/\b(database|storage)\b/, 'database'], [/\b(server)\b/, 'server'], [/\b(mobile|smartphone|device)\b/, 'mobile-alt'],
  [/\b(desktop|monitor|screen)\b/, 'desktop'], [/\b(laptop|computer)\b/, 'laptop'], [/\b(wifi|wireless)\b/, 'wifi'], [/\b(sun|light-?mode)\b/, 'sun'], [/\b(moon|dark-?mode)\b/, 'moon'],
  [/\b(fire|flame|hot)\b/, 'fire'], [/\b(smile|happy|emoji)\b/, 'smile', 'regular'], [/\b(thumbs?-?up|like)\b/, 'thumbs-up'], [/\b(trophy|award|medal|winner)\b/, 'trophy'],
  [/\b(graduation|education|school)\b/, 'graduation-cap'], [/\b(book|docs|documentation|read)\b/, 'book'], [/\b(briefcase|work|job|business)\b/, 'briefcase'],
  [/\b(building|office|company)\b/, 'building'], [/\b(map)\b/, 'map'], [/\b(compass|explore)\b/, 'compass'], [/\b(sparkles?|magic|wand|ai)\b/, 'magic'],
  [/\b(puzzle|integration|plugin)\b/, 'puzzle-piece'], [/\b(refresh|sync|reload|repeat)\b/, 'sync-alt'], [/\b(target|goal|bullseye|focus)\b/, 'bullseye'],
  [/\b(lightbulb|idea|bulb)\b/, 'lightbulb'], [/\b(file|document)\b/, 'file-alt'], [/\b(folder)\b/, 'folder'], [/\b(key)\b/, 'key'], [/\b(fingerprint)\b/, 'fingerprint'],
  [/\b(handshake|partner)\b/, 'handshake'], [/\b(hand|wave)\b/, 'hand-paper'], [/\b(music|audio|sound)\b/, 'music'], [/\b(microphone|mic|podcast)\b/, 'microphone'],
  [/\b(paw|pet|dog|cat)\b/, 'paw'], [/\b(car|vehicle|auto)\b/, 'car'], [/\b(plane|flight|travel)\b/, 'plane'], [/\b(bed|hotel|room)\b/, 'bed'], [/\b(dumbbell|fitness|gym)\b/, 'dumbbell'],
  [/\b(stethoscope|health|medical|doctor)\b/, 'stethoscope'], [/\b(tooth|dental)\b/, 'tooth'], [/\b(paint|brush|design|palette)\b/, 'palette'], [/\b(crown|premium|vip)\b/, 'crown'],
  [/\b(gem|diamond)\b/, 'gem'], [/\b(percent|discount|sale)\b/, 'percent'], [/\b(box|package|product)\b/, 'box'], [/\b(store|shop)\b/, 'store'], [/\b(print|printer)\b/, 'print'],
  [/\b(circle|dot)\b/, 'circle'],
];

// Font Awesome class names already present on the element (e.g. "fa-solid fa-check", "fas fa-envelope").
function directFa(hints) {
  const m = hints.match(/\bfa-(?!solid|regular|brands|light|thin|duotone|fw|lg|xs|sm|[0-9]x|spin|pulse|inverse|stack)([a-z0-9-]+)/);
  if (!m) return null;
  const name = m[1];
  const brand = /\bfab\b|fa-brands/.test(hints);
  const regular = /\bfar\b|fa-regular/.test(hints);
  if (brand && hasIcon(name, 'brands')) return faIcon(name, 'brands');
  if (regular && hasIcon(name, 'regular')) return faIcon(name, 'regular');
  if (hasIcon(name, 'solid')) return faIcon(name, 'solid');
  if (hasIcon(name, 'regular')) return faIcon(name, 'regular');
  if (hasIcon(name, 'brands')) return faIcon(name, 'brands');
  return null;
}

// Bootstrap Icons / Lucide / Feather / Heroicons / Material names come as "bi-envelope", "lucide-mail", "mail" etc.
export function iconFromHints(hints, { href } = {}) {
  const h = String(hints || '').toLowerCase();
  const direct = directFa(h);
  if (direct) return { icon: direct, confidence: 'exact' };
  const brand = brandFor(`${href || ''} ${h}`);
  if (brand && (href || /brand|social|logo|facebook|twitter|instagram|linkedin|youtube|github|tiktok|pinterest|whatsapp|dribbble|behance|discord|telegram/.test(h))) return { icon: brand, confidence: 'name' };
  const words = h.replace(/(bi|lucide|feather|heroicon|icon|icons|material-icons|material-symbols|ti|ri|la|ion|glyphicon)[-_]/g, ' ').replace(/[_#/.]/g, ' ');
  for (const [re, name, lib = 'solid'] of SYNONYMS) {
    if (re.test(words) && hasIcon(name, lib)) return { icon: faIcon(name, lib), confidence: 'name' };
  }
  return null;
}

// Open-source outline/solid icon sets (Lucide, Feather, Heroicons, Tabler), used to
// recognise inline SVG icons by their exact shapes and give them a name.
let OUTLINE = null;
function outline() {
  if (!OUTLINE) OUTLINE = JSON.parse(readFileSync(new URL('../data/outline-icons.json', import.meta.url), 'utf8'));
  return OUTLINE;
}

export function libraryIconBySignature(sig) {
  const hit = sig && outline().bySig[sig];
  return hit ? { set: hit[0], name: hit[1], style: hit[2], tags: hit[3] } : null;
}

export function libraryShapes() {
  return outline().shapes.map(([set, name, style, markup]) => ({ set, name, style, markup }));
}

// Library icon names that differ from Font Awesome's.
const RENAMES = {
  x: 'times', 'x-mark': 'times', 'x-circle': 'times-circle', 'circle-x': 'times-circle', mail: 'envelope', zap: 'bolt', 'map-pin': 'map-marker-alt', 'map-pinned': 'map-marked-alt',
  phone: 'phone-alt', settings: 'cog', 'cog-6-tooth': 'cog', 'trash-2': 'trash-alt', pencil: 'pen', edit: 'edit', 'pencil-square': 'edit', 'external-link': 'external-link-alt',
  'arrow-top-right-on-square': 'external-link-alt', menu: 'bars', 'bars-3': 'bars', 'lock-closed': 'lock', 'lock-open': 'lock-open', 'chat-bubble-left': 'comment', 'message-circle': 'comment',
  'message-square': 'comment-alt', 'chat-bubble-left-right': 'comments', 'shopping-cart': 'shopping-cart', 'credit-card': 'credit-card', 'circle-check': 'check-circle', 'check-circle': 'check-circle',
  'check-badge': 'certificate', 'badge-check': 'certificate', 'shield-check': 'shield-alt', shield: 'shield-alt', 'trending-up': 'chart-line', 'arrow-trending-up': 'chart-line', 'bar-chart': 'chart-bar',
  'bar-chart-2': 'chart-bar', 'chart-bar': 'chart-bar', 'pie-chart': 'chart-pie', 'chart-pie': 'chart-pie', sparkles: 'magic', sparkle: 'magic', 'wand-sparkles': 'magic', globe: 'globe', 'globe-alt': 'globe',
  'refresh-cw': 'sync-alt', 'arrow-path': 'sync-alt', 'rotate-cw': 'redo', 'log-out': 'sign-out-alt', 'log-in': 'sign-in-alt', 'user-plus': 'user-plus', 'users-round': 'users', 'user-group': 'users',
  'help-circle': 'question-circle', 'circle-help': 'question-circle', 'question-mark-circle': 'question-circle', 'alert-circle': 'exclamation-circle', 'circle-alert': 'exclamation-circle',
  'alert-triangle': 'exclamation-triangle', 'triangle-alert': 'exclamation-triangle', 'exclamation-triangle': 'exclamation-triangle', 'info': 'info-circle', 'information-circle': 'info-circle',
  'play-circle': 'play-circle', 'circle-play': 'play-circle', 'calendar-days': 'calendar-alt', calendar: 'calendar-alt', 'clock': 'clock', send: 'paper-plane', 'paper-airplane': 'paper-plane',
  'thumbs-up': 'thumbs-up', 'hand-thumb-up': 'thumbs-up', 'home': 'home', house: 'home', 'building-office': 'building', 'building-2': 'building', 'map': 'map', 'film': 'film', video: 'video',
  'video-camera': 'video', 'smartphone': 'mobile-alt', 'device-phone-mobile': 'mobile-alt', monitor: 'desktop', 'computer-desktop': 'desktop', 'cpu': 'microchip', 'cpu-chip': 'microchip',
  'cloud-upload': 'cloud-upload-alt', 'cloud-download': 'cloud-download-alt', 'arrow-down-tray': 'download', 'arrow-up-tray': 'upload', 'quote': 'quote-left', 'layers': 'layer-group',
  'square-stack': 'layer-group', 'rocket-launch': 'rocket', 'light-bulb': 'lightbulb', 'lightbulb': 'lightbulb', 'currency-dollar': 'dollar-sign', 'dollar-sign': 'dollar-sign', 'gift': 'gift',
  'heart': 'heart', 'star': 'star', 'bell': 'bell', 'search': 'search', 'magnifying-glass': 'search', 'user': 'user', 'user-circle': 'user-circle', 'circle-user': 'user-circle', 'eye': 'eye',
  'chevron-right': 'chevron-right', 'chevron-left': 'chevron-left', 'chevron-down': 'chevron-down', 'chevron-up': 'chevron-up', 'arrow-right': 'arrow-right', 'arrow-left': 'arrow-left',
  'arrow-up': 'arrow-up', 'arrow-down': 'arrow-down', 'plus': 'plus', 'minus': 'minus', 'check': 'check', 'linkedin': 'linkedin-in', 'facebook': 'facebook-f', 'github': 'github', 'twitter': 'twitter',
  'instagram': 'instagram', 'youtube': 'youtube', 'dribbble': 'dribbble', 'twitch': 'twitch', 'gitlab': 'gitlab', 'slack': 'slack', 'figma': 'figma', 'codepen': 'codepen',
};

// A library icon (name, tags, stroke/fill style) → the closest Font Awesome icon.
// Outline icons prefer Font Awesome's Regular (outline) style when it has that icon.
export function faFromLibraryName(name, tags = '', style = 'stroke') {
  const base = String(name).toLowerCase();
  const candidates = [RENAMES[base], base, base.replace(/-(\d+|alt|outline|solid|filled|line|round|rounded|square)$/g, ''), base.replace(/^(circle|square)-/, '')].filter(Boolean);
  for (const c of candidates) {
    if (hasIcon(c, 'brands') && /^(linkedin-in|facebook-f|github|twitter|instagram|youtube|dribbble|twitch|gitlab|slack|figma|codepen)$/.test(c)) return faIcon(c, 'brands');
    if (style === 'stroke' && hasIcon(c, 'regular')) return faIcon(c, 'regular');
    if (hasIcon(c, 'solid')) return faIcon(c, 'solid');
    if (hasIcon(c, 'regular')) return faIcon(c, 'regular');
  }
  const viaHints = iconFromHints(`${base} ${tags}`);
  if (viaHints) {
    const n = viaHints.icon.value.replace(/^fa[srb] fa-/, '');
    if (style === 'stroke' && viaHints.icon.library === 'fa-solid' && hasIcon(n, 'regular')) return faIcon(n, 'regular');
    return viaHints.icon;
  }
  return null;
}

// Candidate shapes for pixel matching, used in the browser (see dom.js).
export function faShapes() {
  const { data } = fa();
  return Object.entries(data).flatMap(([lib, list]) => list.map(([name, w, h, d]) => ({ lib, name, w, h, d })));
}
