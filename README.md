# Web to Elementor

A small web app that turns a **link, pasted HTML, a screenshot or a PDF** into an
Elementor template (`.json`) you can import with **Templates › Import Templates**.

The template is built from Elementor's own widgets and settings, so every part can be
edited in the Elementor panel. No custom CSS is written. Code is used only inside
Elementor's **HTML** widget, and only for the few things Elementor has no widget for
(listed below).

## How each input is read

| Input | How the design is read |
| --- | --- |
| Link | Opened in headless Chromium at 1440px. Every visible element's real computed styles (font family, size, the weight actually drawn, line height, letter spacing, colours, backgrounds, gradients, borders, radius, shadows, padding) and its on-screen box are measured. |
| HTML | Same as a link, rendered from your pasted code. Scripts are blocked; stylesheets, fonts and images load from public URLs. |
| Screenshot | Claude reads the layout (boxes, text, typefaces, sizes, icons, ratings, progress bars) as structured JSON. Colours are then re-sampled from the real pixels. |
| PDF | Claude reads each page the same way; pages are stacked into one long page. |

The measured tree is cleaned up (wrapper divs merged, centred content turned into
"boxed" containers, real distances turned into margins and gaps, side-by-side items
turned into rows or CSS grids) and written as Elementor **Flexbox / Grid Containers**.
Rows stack into one column on phones and large headings scale down.

## What becomes which Elementor widget

| On the page | In Elementor |
| --- | --- |
| Sections, cards, columns, grids, badges, coloured bars and dots (also plain one-colour SVG dots and discs) | Container (flex or grid) with its background, gradient, border, radius, shadow, padding and gap |
| A tint laid over a photo (`::after` overlay) | The container's Background Overlay |
| Headings, eyebrow labels, prices | Heading |
| Paragraphs, lists (nested lists stay one list; numbering, item spacing, dividers and colours are kept), quotes, inline links, highlighted or outlined words (code, small tags), `::before` text such as breadcrumb slashes | Text Editor |
| Large decorative quote marks and other positioned `::before` text | Text Editor placed at the same spot |
| An image floated beside paragraphs (or inside one), with the text wrapping around it | One Text Editor: the image set to the editor's Align left/right, then the paragraphs |
| Dotted leaders and other fillers that stretch between items | Container set to Flex Grow |
| Tables and code blocks | Text Editor (tables keep their styling and stay editable; code keeps its line breaks and syntax colours) |
| Buttons and button-style links, with their icon | Button |
| Nav items and "Read more" links shown as blocks | Text Editor or Heading with the link kept |
| Icon-only buttons (close ×, menu, arrows, also with screen-reader-only labels), menu icons drawn as three bars, and single icons | Icon |
| Lists with icons, plain link lists (footers), lists with dot bullets | Icon List |
| Social links | Social Icons |
| Star ratings | Rating |
| Progress bars | Progress Bar |
| `<details>` FAQs and Bootstrap / ARIA accordions | Accordion (nested) |
| Tab strips (Bootstrap, ARIA `role="tablist"`) | Tabs (nested), every panel converted |
| YouTube, Vimeo, Dailymotion and self-hosted video | Video |
| Google Maps embeds | Google Maps |
| Photos, `<picture>`, canvas charts | Image |
| `<hr>` and drawn rules | Divider |
| Inline SVG icons | Icon, using the closest Font Awesome icon (matched by name, by shape against Lucide, Feather, Heroicons and Tabler outlines, then by pixel comparison) |

### When the HTML widget is used

Only for things free Elementor has no widget for. Each case is listed in the
conversion notes:

- forms and form fields (the Form widget is Elementor Pro). A form card's background, heading
  and intro text become a native container, Heading and Text Editor; only the fields stay in code,
  and they shrink to fit on phones,
- `<audio>` players,
- iframes from other services,
- multi-colour SVG artwork (logos, illustrations, donut charts),
- images that only exist inline (`data:` URLs) and can't be imported by link.

Markup written into HTML or Text Editor widgets is sanitised: scripts, `<style>` blocks, event
handlers, `javascript:` links and remote CSS imports are removed. SVG artwork gets its own ids,
so two pictures on one page never share a gradient or pattern, and colours set by an SVG's own
`<style>` are written onto each shape.

## Copyright safeguards

By default only the **design** is copied:

- Headings and body text become placeholder text of the same length.
- Photos, logos and backgrounds become grey placeholder images of the same size. This also
  covers images, SVG artwork, alt text and labels inside form and table code.
- Fonts are checked against the Google Fonts catalogue. Commercial fonts (Proxima Nova,
  Helvetica Neue, Gotham, SF Pro…) are swapped for a free look-alike and the result
  lists each swap, including fonts set inside rich text and tables. Upload the original in
  Elementor › Custom Fonts only if you hold a licence.

Ticking **"I own this design or have permission to reuse its content"** unlocks keeping
the original text and (for links and HTML) the original image URLs.

Links to private or local network addresses are refused.

## Run it

Requires Node.js 20+.

```bash
npm install
npx playwright install chromium   # one-time browser download
npm start                          # http://localhost:3000
```

On Windows PowerShell, to enable screenshots and PDFs:

```powershell
$env:ANTHROPIC_API_KEY="sk-ant-..."
npm start
```

Links and HTML work without an API key. Screenshots and PDFs use `claude-opus-5-5`
(override with `CLAUDE_MODEL`).

## Import into WordPress

1. WordPress admin › **Templates › Saved Templates** › **Import Templates**.
2. Choose the downloaded `.json` and click **Import Now**.
3. Edit a page with Elementor › folder icon › **My Templates** › **Insert**.
4. In the page settings choose the **Elementor Canvas** layout (the template asks for it),
   so the theme's header, footer and spacing don't change the look.

Built and tested against **Elementor 4.3** (free) with the Hello Elementor theme.
Needs Flexbox Containers and Nested Elements, which are on by default since Elementor 3.15.
Images are copied into your Media Library during import, so the original image links must
be public `http(s)` addresses.

## Tests

```bash
npm test
```

`scripts/fidelity/run.js` checks the real result: it converts a page, imports the
template into a WordPress + Elementor install with WP-CLI, renders both pages in
Chromium and reports a pixel match, every element that moved more than 4px, and any
text or media that went missing.

```bash
WP_PATH=/path/to/wordpress WP_URL=http://localhost:8080 \
  node scripts/fidelity/run.js test/fixtures/saas/index.html --out out/saas
```

`test/fixtures` holds six reference pages (landing, SaaS, restaurant, Bootstrap 5,
long-form article, edge cases).

## Known limits

- Hover states, animations, sliders and carousels are not converted (only the first slide).
- Gradient-filled text uses the gradient's main colour; Elementor has no gradient text.
- Blur effects become soft radial gradients; repeating CSS patterns (dot grids) are left out.
- Sticky headers stay in the normal flow: sticky positioning is an Elementor Pro setting.
- Font Awesome icons are solid or regular glyphs, so thin outline icons look a little heavier.
- Fonts with an optical-size axis (Source Serif 4, Roboto Flex, Fraunces…) load as one fixed size
  through Elementor, so letters are slightly wider and a long paragraph can break one word earlier.
  The conversion notes name these fonts.
- An image that text wraps around stays linked to its original address (the Text Editor doesn't
  import images); upload it to your Media Library and swap it in.
- List number colours set with `::marker` use the text colour.
- Tablet layouts are left to Elementor's defaults; phone layouts stack rows.
- The in-app preview approximates Elementor's CSS; the final look depends on your theme.

Icon recognition data comes from Lucide (ISC), Feather (MIT), Heroicons (MIT) and
Tabler Icons (MIT). Only their shapes and names are used for matching; the output
uses Font Awesome Free 5 icons, which ship with Elementor.
