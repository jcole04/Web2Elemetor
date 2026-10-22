// Renders an Elementor template JSON as standalone HTML, following the CSS
// Elementor generates for flexbox containers and the basic widgets. It is an
// approximation used for the in-app preview and the side-by-side check; the
// real rendering happens in WordPress after import.
import { isGoogleFont, googleFontWeights } from '../fonts.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sz = (v) => (v && v.size !== '' && v.size !== undefined ? `${v.size}${v.unit === 'custom' ? '' : v.unit || 'px'}` : null);
const box = (v) => (v ? `${v.top || 0}${v.unit} ${v.right || 0}${v.unit} ${v.bottom || 0}${v.unit} ${v.left || 0}${v.unit}` : null);

function typo(s, p = 'typography') {
  const css = [];
  if (s[`${p}_font_family`]) css.push(`font-family:'${s[`${p}_font_family`]}',sans-serif`);
  if (sz(s[`${p}_font_size`])) css.push(`font-size:${sz(s[`${p}_font_size`])}`);
  if (s[`${p}_font_weight`]) css.push(`font-weight:${s[`${p}_font_weight`]}`);
  if (sz(s[`${p}_line_height`])) css.push(`line-height:${sz(s[`${p}_line_height`])}`);
  if (sz(s[`${p}_letter_spacing`])) css.push(`letter-spacing:${sz(s[`${p}_letter_spacing`])}`);
  if (s[`${p}_text_transform`]) css.push(`text-transform:${s[`${p}_text_transform`]}`);
  if (s[`${p}_font_style`]) css.push(`font-style:${s[`${p}_font_style`]}`);
  if (s[`${p}_text_decoration`]) css.push(`text-decoration:${s[`${p}_text_decoration`]}`);
  return css;
}

function bg(s, p = 'background') {
  const t = s[`${p}_background`];
  if (t === 'gradient') {
    const ang = s[`${p}_gradient_angle`]?.size ?? 180;
    const a = `${s[`${p}_color`]} ${s[`${p}_color_stop`]?.size ?? 0}%`;
    const b = `${s[`${p}_color_b`]} ${s[`${p}_color_b_stop`]?.size ?? 100}%`;
    return s[`${p}_gradient_type`] === 'radial'
      ? [`background:radial-gradient(at center center,${a},${b})`]
      : [`background:linear-gradient(${ang}deg,${a},${b})`];
  }
  const css = [];
  if (s[`${p}_color`]) css.push(`background-color:${s[`${p}_color`]}`);
  if (s[`${p}_image`]?.url) {
    const pos = s[`${p}_position`] === 'initial' ? `${sz(s[`${p}_xpos`]) || '0px'} ${sz(s[`${p}_ypos`]) || '0px'}` : s[`${p}_position`] || 'center center';
    const size = s[`${p}_size`] === 'initial' ? `${sz(s[`${p}_bg_width`]) || 'auto'} auto` : s[`${p}_size`] || 'cover';
    css.push(`background-image:url('${s[`${p}_image`].url}')`, `background-size:${size}`, `background-position:${pos}`, `background-repeat:${s[`${p}_repeat`] || 'no-repeat'}`);
    if (s[`${p}_attachment`] === 'fixed') css.push('background-attachment:fixed');
  }
  return css;
}

function textShadow(s, p = 'text_shadow') {
  const v = s[`${p}_text_shadow`];
  return s[`${p}_text_shadow_type`] === 'yes' && v ? [`text-shadow:${v.horizontal}px ${v.vertical}px ${v.blur}px ${v.color}`] : [];
}

// Advanced > Position / Transform, shared by widgets and containers.
function placement(s, isContainer) {
  const css = [];
  if ((isContainer ? s.position : s._position) === 'absolute') {
    css.push('position:absolute');
    css.push(s._offset_orientation_h === 'end' ? `right:${sz(s._offset_x_end) || 0}` : `left:${sz(s._offset_x) || 0}`);
    css.push(s._offset_orientation_v === 'end' ? `bottom:${sz(s._offset_y_end) || 0}` : `top:${sz(s._offset_y) || 0}`);
  }
  const z = isContainer ? s.z_index : s._z_index;
  if (z !== undefined && z !== '') css.push(`z-index:${z}`);
  if (s._transform_rotate_popover && s._transform_rotateZ_effect?.size) css.push(`transform:rotate(${s._transform_rotateZ_effect.size}deg)`);
  if (s._grid_column || s.grid_column) css.push(`grid-column:span ${s._grid_column || s.grid_column}`);
  if (s._grid_row || s.grid_row) css.push(`grid-row:span ${s._grid_row || s.grid_row}`);
  return css;
}

const FA = { 'fa-solid': 'fas', 'fa-regular': 'far', 'fa-brands': 'fab' };
const faTag = (icon, style = '') => (icon?.value ? `<i class="${esc(icon.value)}" style="${style}"></i>` : '');

function border(s, p = 'border', r = 'border_radius') {
  const css = [];
  if (s[`${p}_border`]) css.push(`border-style:${s[`${p}_border`]}`, `border-width:${box(s[`${p}_width`])}`, `border-color:${s[`${p}_color`] || '#000'}`);
  if (s[r]) css.push(`border-radius:${box(s[r])}`);
  return css;
}

function shadow(s, p) {
  const v = s[`${p}_box_shadow`];
  return s[`${p}_box_shadow_type`] === 'yes' && v ? [`box-shadow:${v.horizontal}px ${v.vertical}px ${v.blur}px ${v.spread}px ${v.color}`] : [];
}

const JUSTIFY = { start: 'flex-start', center: 'center', end: 'flex-end', justify: 'stretch' };

function widgetWrap(s, inner, extra = []) {
  const css = ['position:relative', 'min-width:0'];
  if (s._margin) css.push(`margin:${box(s._margin)}`);
  if (s._padding) css.push(`padding:${box(s._padding)}`);
  css.push(...bg(s, '_background'), ...border(s, '_border', '_border_radius'), ...shadow(s, '_box_shadow'), ...placement(s, false));
  if (s._flex_align_self) css.push(`align-self:${s._flex_align_self}`);
  if (s._element_width === 'auto') css.push('width:auto', 'max-width:100%');
  if (s._element_width === 'initial' && s._element_custom_width) css.push(`width:${sz(s._element_custom_width)}`, 'max-width:100%', 'flex-shrink:1');
  css.push(...extra);
  return `<div class="w" data-id="${s.__id}" style="${css.join(';')}">${inner}</div>`;
}

function widget(el) {
  const s = { ...el.settings, __id: el.id };
  switch (el.widgetType) {
    case 'heading': {
      const tag = s.header_size || 'h2';
      const css = ['margin:0', `color:${s.title_color || 'inherit'}`, `text-align:${s.align || 'start'}`, ...typo(s), ...textShadow(s)];
      return widgetWrap(s, `<${tag} style="${css.join(';')}">${s.title}</${tag}>`);
    }
    case 'text-editor': {
      const css = [`color:${s.text_color || 'inherit'}`, `text-align:${s.align || 'start'}`, ...typo(s), ...textShadow(s)];
      if (s.paragraph_spacing?.size) css.push(`--ps:${s.paragraph_spacing.size}px`);
      return widgetWrap(s, `<div class="te" style="${css.join(';')}">${s.editor}</div>`);
    }
    case 'button': {
      const css = ['display:inline-flex', 'align-items:center', 'justify-content:center', 'text-decoration:none', 'line-height:1', `color:${s.button_text_color || '#fff'}`, `padding:${box(s.text_padding) || '12px 24px'}`, ...typo(s), ...textShadow(s), ...bg(s), ...border(s), ...shadow(s, 'button_box_shadow')];
      if (!s.background_background) css.push('background-color:#69727d');
      if (s.align === 'justify') css.push('width:100%');
      if (s.selected_icon?.value) css.push(`gap:${sz(s.icon_indent) || '8px'}`, `flex-direction:${s.icon_align || 'row'}`);
      const align = { left: 'left', center: 'center', right: 'right' }[s.align] || 'left';
      return widgetWrap(s, `<a href="${esc(s.link?.url || '#')}" style="${css.join(';')}">${faTag(s.selected_icon)}<span>${esc(s.text)}</span></a>`, [`text-align:${align}`]);
    }
    case 'image': {
      const css = ['display:inline-block', 'vertical-align:middle', `width:${sz(s.width) || 'auto'}`, `max-width:${sz(s.space) || '100%'}`, ...border(s, 'image_border', 'image_border_radius'), ...shadow(s, 'image_box_shadow')];
      if (sz(s.height)) css.push(`height:${sz(s.height)}`, `object-fit:${s['object-fit'] || 'cover'}`);
      if (s['object-position']) css.push(`object-position:${s['object-position']}`);
      if (s.opacity?.size !== undefined) css.push(`opacity:${s.opacity.size}`);
      return widgetWrap(s, `<img src="${esc(s.image?.url)}" alt="${esc(s.image?.alt)}" style="${css.join(';')}">`, [`text-align:${s.align === 'center' ? 'center' : s.align === 'end' ? 'right' : 'left'}`, 'line-height:0']);
    }
    case 'icon': {
      const size = sz(s.size) || '50px';
      const view = s.view || 'default';
      const css = [`font-size:${size}`, 'display:inline-block', 'line-height:1', 'text-align:center'];
      if (view === 'stacked') css.push(`background:${s.primary_color || '#69727d'}`, `color:${s.secondary_color || '#fff'}`, `padding:${sz(s.icon_padding) || '.5em'}`);
      else if (view === 'framed') css.push(`color:${s.primary_color || '#69727d'}`, `border:solid ${s.primary_color || '#69727d'}`, `border-width:${box(s.border_width) || '3px'}`, `padding:${sz(s.icon_padding) || '.5em'}`, s.secondary_color ? `background:${s.secondary_color}` : '');
      else css.push(`color:${s.primary_color || '#69727d'}`);
      if (view !== 'default') css.push(`border-radius:${s.shape === 'circle' ? '50%' : s.shape === 'rounded' ? box(s.border_radius) || '10%' : '0'}`);
      const rot = s.rotate?.size ? `transform:rotate(${s.rotate.size}deg);` : '';
      return widgetWrap(s, `<span style="${css.filter(Boolean).join(';')}">${faTag(s.selected_icon, `display:block;width:1em;height:1em;${rot}`)}</span>`, [`text-align:${{ start: 'left', center: 'center', end: 'right' }[s.align] || 'center'}`, 'line-height:1']);
    }
    case 'html':
      return widgetWrap(s, s.html || '');
    case 'video': {
      const ratio = { 169: '16/9', 219: '21/9', 43: '4/3', 32: '3/2', 11: '1/1', 916: '9/16' }[s.aspect_ratio || '169'] || s.aspect_ratio;
      if (s.show_image_overlay === 'yes' && s.image_overlay?.url) {
        return widgetWrap(s, `<div style="position:relative;aspect-ratio:${ratio};background:url('${esc(s.image_overlay.url)}') center/cover"><i class="eicon-play" style="position:absolute;inset:0;margin:auto;width:80px;height:80px;border-radius:50%;background:rgba(0,0,0,.4)"></i></div>`);
      }
      if (s.video_type === 'hosted') return widgetWrap(s, `<video src="${esc(s.external_url?.url)}" ${s.controls === '' ? '' : 'controls'} ${s.autoplay === 'yes' ? 'autoplay' : ''} ${s.mute === 'yes' ? 'muted' : ''} ${s.loop === 'yes' ? 'loop' : ''} style="width:100%;display:block"></video>`);
      const url = s.video_type === 'vimeo' ? `https://player.vimeo.com/video/${(s.vimeo_url || '').split('/').pop()}` : `https://www.youtube.com/embed/${(s.youtube_url || '').split('v=').pop()}`;
      return widgetWrap(s, `<iframe src="${esc(url)}" style="width:100%;aspect-ratio:${ratio};border:0;display:block" allowfullscreen></iframe>`);
    }
    case 'google_maps':
      return widgetWrap(s, `<iframe src="https://maps.google.com/maps?q=${encodeURIComponent(s.address || '')}&t=m&z=${s.zoom?.size || 10}&output=embed&iwloc=near" style="width:100%;height:${sz(s.height) || '300px'};border:0;display:block"></iframe>`);
    case 'icon-list': {
      const inline = s.view === 'inline';
      const space = s.space_between?.size || 0;
      const items = (s.icon_list || []).map((it, i) => `<li style="display:flex;align-items:center;${inline ? `margin:0 ${space / 2}px` : i ? `padding-top:${space / 2}px` : ''};${!inline && i < s.icon_list.length - 1 ? `padding-bottom:${space / 2}px` : ''}"><span style="display:flex;padding-inline-end:${(s.text_indent?.size || 0) + 0.25 * (s.icon_size?.size || 14) + 5}px;color:${s.icon_color || 'inherit'};font-size:${sz(s.icon_size) || '14px'}">${faTag(it.selected_icon, 'width:1em;height:1em;text-align:center')}</span><span style="color:${s.text_color || 'inherit'};${typo(s, 'icon_typography').join(';')}">${esc(it.text)}</span></li>`).join('');
      return widgetWrap(s, `<ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:${inline ? 'row' : 'column'};flex-wrap:wrap${inline ? `;margin-inline:-${space / 2}px` : ''}">${items}</ul>`);
    }
    case 'social-icons': {
      const size = s.icon_size?.size || 25;
      const pad = s.icon_padding ? sz(s.icon_padding) : '.5em';
      const radius = s.shape === 'circle' ? '50%' : s.shape === 'rounded' ? box(s.border_radius) || '10%' : '0';
      const items = (s.social_icon_list || []).map((it) => `<a href="${esc(it.link?.url || '#')}" style="display:inline-flex;align-items:center;justify-content:center;font-size:${size}px;width:calc(${size}px + 2 * ${pad});height:calc(${size}px + 2 * ${pad});border-radius:${radius};background:${s.icon_primary_color || '#69727d'};color:${s.icon_secondary_color || '#fff'};${border(s, 'image_border', '_none').join(';')}">${faTag(it.social_icon, 'width:1em;height:1em;text-align:center')}</a>`).join('');
      return widgetWrap(s, `<div style="display:flex;flex-wrap:wrap;gap:${sz(s.row_gap) || '0px'} ${sz(s.icon_spacing) || '5px'};justify-content:${{ left: 'flex-start', center: 'center', right: 'flex-end' }[s.align] || 'center'}">${items}</div>`);
    }
    case 'rating': {
      const max = s.rating_scale?.size || 5;
      const val = Number(s.rating_value ?? max);
      const stars = Array.from({ length: max }, (_, i) => `<span style="position:relative;display:inline-block;color:${s.icon_unmarked_color || '#ccd6df'}">${faTag(s.rating_icon)}<span style="position:absolute;left:0;top:0;overflow:hidden;width:${Math.max(0, Math.min(1, val - i)) * 100}%;color:${s.icon_color || '#f0ad4e'}">${faTag(s.rating_icon)}</span></span>`).join('');
      return widgetWrap(s, `<div style="display:flex;gap:${sz(s.icon_gap) || '0px'};font-size:${sz(s.icon_size) || '24px'};justify-content:${JUSTIFY[s.icon_alignment] || 'flex-start'}">${stars}</div>`);
    }
    case 'progress': {
      const h = sz(s.bar_height) || '30px';
      return widgetWrap(s, `<div style="background:${s.bar_bg_color || '#eee'};border-radius:${sz(s.bar_border_radius) || '0'};overflow:hidden"><div style="width:${s.percent?.size ?? 50}%;height:${h};line-height:${h};background:${s.bar_color || '#69727d'};color:${s.bar_inline_color || '#fff'};padding:0 10px;white-space:nowrap;${typo(s, 'bar_inner_typography').join(';')}">${esc(s.inner_text || '')}${s.display_percentage === 'show' ? `<span style="float:right">${s.percent?.size ?? 50}%</span>` : ''}</div></div>`);
    }
    case 'nested-accordion': {
      const items = (s.items || []).map((it, i) => {
        const open = s.default_state === 'expanded' && i === 0;
        const title = [...typo(s, 'title_typography'), `color:${s.normal_title_color || 'inherit'}`, `padding:${box(s.accordion_padding) || '10px'}`, ...bg(s, 'accordion_background_normal'), ...border(s, 'accordion_border_normal', '_none'), 'display:flex', 'justify-content:space-between', 'align-items:center', 'cursor:pointer', 'list-style:none'];
        if (s.accordion_border_radius) title.push(`border-radius:${box(s.accordion_border_radius)}`);
        const kid = el.elements[i] ? render(el.elements[i]) : '';
        return `<details ${open ? 'open' : ''} style="margin-bottom:${i < s.items.length - 1 ? sz(s.accordion_item_title_space_between) || '0px' : '0'}"><summary style="${title.join(';')}"><span>${esc(it.item_title)}</span><span style="font-size:${sz(s.icon_size) || '15px'};color:${s.normal_icon_color || 'inherit'}">${faTag({ value: open ? 'fas fa-minus' : 'fas fa-plus' })}</span></summary>${kid}</details>`;
      }).join('');
      return widgetWrap(s, `<div>${items}</div>`);
    }
    case 'nested-tabs': {
      const vertical = s.tabs_direction === 'inline-start';
      const stretch = s.tabs_justify_horizontal === 'stretch';
      const align = { start: 'flex-start', center: 'center', end: 'flex-end' }[s.title_alignment] || 'center';
      const titles = (s.tabs || []).map((t, i) => {
        const st = i === 0 ? '_active' : '';
        const css = [...typo(s, 'title_typography'), `color:${(i === 0 ? s.title_text_color_active : s.title_text_color) || 'inherit'}`, `padding:${box(s.padding) || '15px 35px'}`, ...bg(s, `tabs_title_background_color${st}`), ...border(s, `tabs_title_border${st}`, 'tabs_title_border_radius'), 'display:flex', `justify-content:${align}`, 'cursor:pointer'];
        if (stretch) css.push('flex:1 1 0');
        return `<div style="${css.join(';')}">${esc(t.tab_title)}</div>`;
      }).join('');
      const heading = [`display:flex`, `flex-direction:${vertical ? 'column' : 'row'}`, `gap:${sz(s.tabs_title_space_between) ?? '10px'}`, 'flex-shrink:0'];
      if (vertical) heading.push(`width:${sz(s.tabs_width) || '240px'}`);
      else heading.push(`justify-content:${{ start: 'flex-start', center: 'center', end: 'flex-end' }[s.tabs_justify_horizontal] || 'center'}`);
      const panel = el.elements[0] ? render(el.elements[0]) : '';
      const frame = [...bg(s, 'box_background_color'), ...border(s, 'box_border', 'box_border_radius'), 'flex-grow:1', 'min-width:0', 'display:flex'];
      const wrap = ['display:flex', `flex-direction:${vertical ? 'row' : 'column'}`, `gap:${sz(s.tabs_title_spacing) ?? '10px'}`];
      return widgetWrap(s, `<div style="${wrap.join(';')}"><div style="${heading.join(';')}">${titles}</div><div style="${frame.join(';')}">${panel}</div></div>`);
    }
    case 'divider':
      return widgetWrap(s, `<div style="padding:${sz(s.gap) || '15px'} 0"><div style="border-top:${sz(s.weight) || '1px'} ${s.style || 'solid'} ${s.color || '#000'};width:${sz(s.width) || '100%'}"></div></div>`);
    case 'spacer':
      return widgetWrap(s, `<div style="height:${sz(s.space) || '50px'}"></div>`);
    default:
      return '';
  }
}

function container(el) {
  const s = el.settings;
  const grid = s.container_type === 'grid';
  const outer = [grid ? 'display:grid' : 'display:flex', 'position:relative', 'box-sizing:border-box', `margin:${box(s.margin) || 0}`, `padding:${box(s.padding) || '10px'}`, ...bg(s), ...border(s), ...shadow(s, 'box_shadow'), ...placement(s, true)];
  if (sz(s.min_height)) outer.push(`min-height:${sz(s.min_height)}`);
  if (s._flex_align_self) outer.push(`align-self:${s._flex_align_self}`);
  if (s.overflow) outer.push(`overflow:${s.overflow}`);
  const cols = s.grid_columns_grid ? (s.grid_columns_grid.unit === 'custom' ? s.grid_columns_grid.size : `repeat(${s.grid_columns_grid.size},1fr)`) : 'repeat(3,1fr)';
  const flex = grid
    ? [`grid-template-columns:${cols}`, `grid-template-rows:${s.grid_rows_grid?.unit === 'custom' ? s.grid_rows_grid.size : 'auto'}`, `gap:${s.grid_gaps ? `${s.grid_gaps.row}px ${s.grid_gaps.column}px` : '20px'}`, `align-items:${s.grid_align_items || 'stretch'}`]
    : [`flex-direction:${s.flex_direction || 'column'}`, `flex-wrap:${s.flex_wrap || 'nowrap'}`, `justify-content:${s.flex_justify_content || 'flex-start'}`, `align-items:${s.flex_align_items || 'stretch'}`, `gap:${s.flex_gap ? `${s.flex_gap.row}px ${s.flex_gap.column}px` : '20px'}`];
  let kids = el.elements.map(render).join('');
  if (s.background_overlay_background) {
    const ov = [...bg(s, 'background_overlay'), 'position:absolute', 'inset:0', `opacity:${s.background_overlay_opacity?.size ?? 0.5}`, 'pointer-events:none', 'border-radius:inherit'];
    kids = `<div style="${ov.join(';')}"></div>` + kids;
  }
  const tag = s.html_tag === 'a' ? 'a' : 'div';
  const href = tag === 'a' ? ` href="${esc(s.link?.url || '#')}"` : '';
  if (s.content_width === 'boxed') {
    outer.push('width:100%', 'flex-direction:column', 'align-items:center');
    const inner = [grid ? 'display:grid' : 'display:flex', 'flex-grow:1', 'width:100%', `max-width:${sz(s.boxed_width) || '1140px'}`, ...flex];
    return `<${tag}${href} class="e-con" data-id="${el.id}" style="${outer.join(';')}"><div class="e-con-inner" style="${inner.join(';')}">${kids}</div></${tag}>`;
  }
  // Rows wider than their parent (negative side margins) are not clamped.
  outer.push(`width:${sz(s.width) || '100%'}`, /\+/.test(sz(s.width) || '') ? 'max-width:none' : 'max-width:100%', ...flex);
  if (s._flex_size === 'grow') outer.push('flex:1 0 auto');
  else if (s._flex_size === 'none') outer.push('flex:0 0 auto');
  return `<${tag}${href} class="e-con" data-id="${el.id}" style="${outer.join(';')}">${kids}</${tag}>`;
}

// Phone overrides (Elementor's *_mobile settings) as a media query.
function mobileRules(el, out) {
  const s = el.settings || {};
  const sel = `[data-id="${el.id}"]`;
  if (s.flex_direction_mobile) out.push(`${sel},${sel}>.e-con-inner{flex-direction:${s.flex_direction_mobile}!important}`);
  if (s.flex_wrap_mobile) out.push(`${sel},${sel}>.e-con-inner{flex-wrap:${s.flex_wrap_mobile}!important}`);
  if (sz(s.width_mobile)) out.push(`${sel}{width:${sz(s.width_mobile)}!important}`);
  if (s.grid_columns_grid_mobile) out.push(`${sel},${sel}>.e-con-inner{grid-template-columns:repeat(${s.grid_columns_grid_mobile.size},1fr)!important}`);
  if (s.flex_gap_mobile) out.push(`${sel},${sel}>.e-con-inner{gap:${s.flex_gap_mobile.row}px ${s.flex_gap_mobile.column}px!important}`);
  if (s.padding_mobile) out.push(`${sel}{padding:${box(s.padding_mobile)}!important}`);
  if (s.margin_mobile || s._margin_mobile) out.push(`${sel}{margin:${box(s.margin_mobile || s._margin_mobile)}!important}`);
  if (s._element_width_mobile === 'inherit') out.push(`${sel}{width:100%!important}`);
  for (const [k, v] of Object.entries(s)) {
    if (/_font_size_mobile$/.test(k) && sz(v)) out.push(`${sel} h1,${sel} h2,${sel} h3,${sel} h4,${sel} h5,${sel} h6,${sel} .te,${sel} a{font-size:${sz(v)}!important}`);
  }
  (el.elements || []).forEach((c) => mobileRules(c, out));
  return out;
}

function render(el) {
  return el.elType === 'widget' ? widget(el) : container(el);
}

export function renderPreview(template) {
  const fonts = new Set();
  const collect = (el) => {
    for (const [k, v] of Object.entries(el.settings || {})) if (k.endsWith('_font_family') && isGoogleFont(v)) fonts.add(v);
    (el.elements || []).forEach(collect);
  };
  template.content.forEach(collect);
  const link = fonts.size
    ? `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${[...fonts].map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@${googleFontWeights(f).join(';')}`).join('&')}&display=swap">`
    : '';
  const ps = template.page_settings || {};
  const mobile = template.content.flatMap((el) => mobileRules(el, []));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(template.title)}</title>${link}
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.3/css/all.min.css">
<style>*,*::before,*::after{box-sizing:border-box}a.e-con{text-decoration:none;color:inherit}summary::-webkit-details-marker{display:none}body{margin:0;background:${ps.background_color || '#fff'};font-family:Arial,sans-serif;font-size:16px;line-height:1.5}.te p{margin:0 0 var(--ps,0)}.te::after{content:'';display:table;clear:both}.te ul,.te ol{margin:0}img{max-width:100%}@media (max-width:767px){${mobile.join('')}}</style>
</head><body>${template.content.map(render).join('')}</body></html>`;
}
