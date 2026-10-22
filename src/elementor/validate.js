// Structural checks that mirror what Elementor's importer relies on
// (Source_Local::import_single_template / save_item and Element_Base).
import { ELEMENTOR_DB_VERSION } from './build.js';

const WIDGETS = new Set([
  'heading', 'text-editor', 'button', 'image', 'icon', 'divider', 'spacer', 'html', 'video', 'google_maps',
  'icon-list', 'social-icons', 'rating', 'progress', 'nested-accordion', 'nested-tabs',
]);
const FA_PREFIX = { 'fa-solid': 'fas', 'fa-regular': 'far', 'fa-brands': 'fab' };

// Icons pass through Elementor's inline-SVG renderer, which fails on values it cannot parse.
function iconErrors(v, where) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !('value' in v)) return [];
  if (v.value === '' && v.library === '') return [];
  if (v.library === 'svg') return v.value?.url ? [] : [`${where}: SVG icon has no URL.`];
  const prefix = FA_PREFIX[v.library];
  if (!prefix || !new RegExp(`^${prefix} fa-[a-z0-9-]+$`).test(v.value)) return [`${where}: bad icon ${JSON.stringify(v)}.`];
  return [];
}
// Widgets that hold their own child containers (one per item).
const NESTED_WIDGETS = new Set(['nested-accordion', 'nested-tabs']);
const ELTYPES = new Set(['container', 'section', 'column', 'widget']);
const TEMPLATE_TYPES = new Set(['page', 'section', 'container']);

export function validateTemplate(t) {
  const errors = [];
  if (!t || typeof t !== 'object' || Array.isArray(t)) return ['Template must be a JSON object.'];
  for (const key of ['content', 'page_settings', 'version', 'title', 'type']) {
    if (!(key in t)) errors.push(`Missing top-level key "${key}".`);
  }
  if (!Array.isArray(t.content)) errors.push('"content" must be an array of elements.');
  if (t.version !== ELEMENTOR_DB_VERSION) errors.push(`"version" should be "${ELEMENTOR_DB_VERSION}".`);
  if (!TEMPLATE_TYPES.has(t.type)) errors.push(`"type" must be one of ${[...TEMPLATE_TYPES].join(', ')}.`);
  if (typeof t.title !== 'string' || !t.title.trim()) errors.push('"title" must be a non-empty string.');
  if (typeof t.page_settings !== 'object' || t.page_settings === null) errors.push('"page_settings" must be an object.');

  const ids = new Set();
  const walk = (el, path, depth) => {
    if (!el || typeof el !== 'object') return errors.push(`${path}: element must be an object.`);
    if (typeof el.id !== 'string' || !/^[0-9a-z]{7,8}$/.test(el.id)) errors.push(`${path}: bad id "${el.id}".`);
    else if (ids.has(el.id)) errors.push(`${path}: duplicate id "${el.id}".`);
    ids.add(el.id);
    if (!ELTYPES.has(el.elType)) errors.push(`${path}: unknown elType "${el.elType}".`);
    if (typeof el.settings !== 'object' || el.settings === null) errors.push(`${path}: settings must be an object.`);
    if (!Array.isArray(el.elements)) errors.push(`${path}: elements must be an array.`);
    if (el.elType === 'widget') {
      if (!WIDGETS.has(el.widgetType)) errors.push(`${path}: unexpected widgetType "${el.widgetType}".`);
      if (el.elements?.length && !NESTED_WIDGETS.has(el.widgetType)) errors.push(`${path}: widgets cannot have child elements.`);
      if (NESTED_WIDGETS.has(el.widgetType)) {
        if ((el.elements || []).some((c) => c.elType !== 'container')) errors.push(`${path}: nested widget children must be containers.`);
        const items = el.settings?.items || el.settings?.tabs;
        if (Array.isArray(items) && items.length !== (el.elements || []).length) errors.push(`${path}: one container is needed per item.`);
      }
    } else if (el.elType === 'container') {
      if (depth === 0 && el.isInner) errors.push(`${path}: top-level container must have isInner false.`);
      if (depth > 0 && !el.isInner) errors.push(`${path}: nested container must have isInner true.`);
    }
    for (const [k, v] of Object.entries(el.settings || {})) {
      if (v === null || v === undefined) errors.push(`${path}: setting "${k}" is empty.`);
      if (/color$|_color_b$/.test(k) && !/^(icon_color|item_icon_color)$/.test(k) && typeof v === 'string' && !/^#[0-9A-F]{6}([0-9A-F]{2})?$/i.test(v)) errors.push(`${path}: setting "${k}" is not a hex colour (${v}).`);
      // Custom CSS is never written; only Elementor's own settings are used.
      if (k === 'custom_css' || k === '_custom_css') errors.push(`${path}: custom CSS is not allowed.`);
      if ((k === 'html' || k === 'editor') && typeof v === 'string' && /<style\b/i.test(v)) errors.push(`${path}: <style> blocks are not allowed.`);
      errors.push(...iconErrors(v, `${path}.${k}`));
      if (Array.isArray(v)) v.forEach((row, i) => Object.entries(row || {}).forEach(([rk, rv]) => errors.push(...iconErrors(rv, `${path}.${k}.${i}.${rk}`))));
    }
    (el.elements || []).forEach((c, i) => walk(c, `${path}.${i}`, depth + 1));
  };
  (t.content || []).forEach((el, i) => walk(el, `content.${i}`, 0));
  try {
    JSON.parse(JSON.stringify(t));
  } catch {
    errors.push('Template is not serialisable JSON.');
  }
  return errors;
}
