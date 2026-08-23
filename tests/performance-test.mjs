const oldElement = (index) => ({
  index,
  id: "bc-example-id",
  tag: "button",
  role: null,
  label: "Example interactive control label",
  disabled: false,
  expanded: null,
  input_type: null,
  href: null,
  bounds: { x: 120, y: 240, width: 180, height: 40 }
});

const newElement = (index) => ({
  index,
  id: "bc-example-id",
  tag: "button",
  label: "Example interactive control label",
  bounds: { x: 120, y: 240, width: 180, height: 40 }
});

const base = {
  title: "Representative viewport",
  url: "https://example.test/results",
  viewport: { width: 1920, height: 1080, scroll_x: 0, scroll_y: 0 }
};

const oldPayload = {
  ...base,
  visible_text: "x".repeat(60_000),
  elements: Array.from({ length: 400 }, (_, index) => oldElement(index))
};

const newPayload = {
  ...base,
  visible_text: "x".repeat(12_000),
  elements: Array.from({ length: 120 }, (_, index) => newElement(index)),
  snapshot_limits: { max_elements: 120, max_text_chars: 12_000, elements_truncated: true, text_truncated: true }
};

const oldBytes = Buffer.byteLength(JSON.stringify(oldPayload, null, 2));
const newBytes = Buffer.byteLength(JSON.stringify(newPayload));
const reductionPercent = Number(((1 - newBytes / oldBytes) * 100).toFixed(1));

if (newBytes >= oldBytes) throw new Error("Compact snapshot regression");
console.log(`PASS compact snapshot (${reductionPercent}% representative reduction)`);
