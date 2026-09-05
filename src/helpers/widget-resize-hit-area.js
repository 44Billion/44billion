// Resize nodes protrude 5px outside the widget and are 12px wide. Their
// expanded hit area normally reaches 17px inward and 12px either side of
// the edge midpoint. Keep the outward/tangential reach when avoiding buttons.
export function getWidgetResizeHitInsets ({ width, height, controls }) {
  const depth = { top: 17, right: 17, bottom: 17, left: 17 }
  const intersects = (start, end, center) => start < center + 12 && end > center - 12
  const limit = (side, distance) => { depth[side] = Math.min(depth[side], Math.max(0, distance - 2)) }
  for (const control of controls) {
    const right = control.left + control.width
    const bottom = control.top + control.height
    if (intersects(control.left, right, width / 2)) {
      limit('top', control.top)
      limit('bottom', height - bottom)
    }
    if (intersects(control.top, bottom, height / 2)) {
      limit('left', control.left)
      limit('right', width - right)
    }
  }
  // The visible node extends 7px inward. Negative insets expand its span;
  // positive insets trim only the side facing the widget's center.
  return Object.fromEntries(Object.entries(depth).map(([side, value]) => [side, 7 - value]))
}
