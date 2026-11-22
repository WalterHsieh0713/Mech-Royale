export type Point = [number, number]
export type Zone = { center: Point; radius: number; next_center: Point; next_radius: number; shrink_start: number; shrink_end: number }

export function zoneAt(zone: Zone, time: number) {
  const fraction = Math.max(0, Math.min(1, (time - zone.shrink_start) / Math.max(0.001, zone.shrink_end - zone.shrink_start)))
  return {
    center: [
      zone.center[0] + (zone.next_center[0] - zone.center[0]) * fraction,
      zone.center[1] + (zone.next_center[1] - zone.center[1]) * fraction,
    ] as Point,
    radius: zone.radius + (zone.next_radius - zone.radius) * fraction,
  }
}

export function zoneMargin(zone: Zone, point: Point, time: number) {
  const { center, radius } = zoneAt(zone, time)
  return radius - Math.hypot(point[0] - center[0], point[1] - center[1])
}

export function rotationMargin(zone: Zone): number {
  return Math.min(4, Math.max(0.25, zone.next_radius * 0.12))
}

/** Estimate how much of the previous circle can feed traffic into an approach. */
export function rotationPressure(zone: Zone, point: Point): number {
  const shiftX = zone.next_center[0] - zone.center[0]
  const shiftY = zone.next_center[1] - zone.center[1]
  const shift = Math.hypot(shiftX, shiftY)
  const dx = point[0] - zone.next_center[0], dy = point[1] - zone.next_center[1]
  const radius = Math.hypot(dx, dy)
  if (shift < 1 || radius < zone.next_radius * 0.18) return 0.5
  const projection = (shiftX * dx + shiftY * dy) / radius
  const discriminant = projection ** 2 + zone.radius ** 2 - shift ** 2
  const previousEdge = discriminant > 0 ? -projection + Math.sqrt(discriminant) : 0
  const approachWidth = Math.max(0, previousEdge - zone.next_radius)
  const widest = Math.max(1, zone.radius + shift - zone.next_radius)
  return Math.min(1, approachWidth / widest)
}

/** Sample usable entry arcs even when the next circle is already small. */
export function rotationEntries(zone: Zone, from: Point, reserve: number): { direct: Point; entries: Point[] } {
  const [centerX, centerY] = zone.next_center
  const fromAngle = Math.atan2(from[1] - centerY, from[0] - centerX)
  const shiftAngle = Math.atan2(centerY - zone.center[1], centerX - zone.center[0])
  // Keep space inside the requested reserve after snapping onto the navigation grid.
  const rim = Math.min(zone.next_radius * 0.85, Math.max(0, zone.next_radius - reserve - 1.5))
  const pointAt = (radius: number, angle: number): Point =>
    [centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle)]
  const entries: Point[] = []
  for (const fraction of [1, 0.55]) {
    for (let i = 0; i < 12; i++) entries.push(pointAt(rim * fraction, shiftAngle + i * Math.PI / 6))
  }
  return { direct: pointAt(rim, fromAngle), entries }
}

/** Find the first crossing into the announced circle along a planned route. */
export function rotationEntry(zone: Zone, from: Point, route: readonly Point[]): Point | null {
  const [cx, cy] = zone.next_center
  const radiusSquared = zone.next_radius ** 2
  if ((from[0] - cx) ** 2 + (from[1] - cy) ** 2 <= radiusSquared) return null
  let previous = from
  for (const [x, y] of route) {
    const dx = x - previous[0], dy = y - previous[1]
    const ox = previous[0] - cx, oy = previous[1] - cy
    const lengthSquared = dx ** 2 + dy ** 2
    const projection = ox * dx + oy * dy
    const discriminant = projection ** 2 - lengthSquared * (ox ** 2 + oy ** 2 - radiusSquared)
    if (lengthSquared > 0 && discriminant > 0) {
      const fraction = (-projection - Math.sqrt(discriminant)) / lengthSquared
      if (fraction >= 0 && fraction <= 1) return [previous[0] + fraction * dx, previous[1] + fraction * dy]
    }
    previous = [x, y]
  }
  return null
}

export function routeTiming(zone: Zone, start: Point, points: Point[], time: number, speed: number, dwellAfter = -1, dwell = 0) {
  let previous = start
  let minMargin = zoneMargin(zone, start, time)
  let outsideSeconds = 0
  for (const [index, point] of points.entries()) {
    const distance = Math.hypot(point[0] - previous[0], point[1] - previous[1])
    const seconds = distance / speed
    const samples = Math.max(1, Math.ceil(Math.max(distance / 7, seconds)))
    for (let sample = 1; sample <= samples; sample++) {
      const fraction = sample / samples
      const position: Point = [
        previous[0] + (point[0] - previous[0]) * fraction,
        previous[1] + (point[1] - previous[1]) * fraction,
      ]
      const margin = zoneMargin(zone, position, time + seconds * fraction)
      minMargin = Math.min(minMargin, margin)
      if (margin < 0) outsideSeconds += seconds / samples
    }
    time += seconds
    if (index === dwellAfter && dwell > 0) {
      const intervals = Math.ceil(dwell)
      for (let step = 1; step <= intervals; step++) {
        const margin = zoneMargin(zone, point, time + step * dwell / intervals)
        minMargin = Math.min(minMargin, margin)
        if (margin < 0) outsideSeconds += dwell / intervals
      }
      time += dwell
    }
    previous = point
  }
  return { arrival: time, minMargin, outsideSeconds }
}

export function leaveBy(zone: Zone, point: Point, time: number, reserve: number) {
  if (zoneMargin(zone, point, time) <= reserve) return time
  // The advertised next circle is the farthest future state we can predict.
  if (zoneMargin(zone, point, Math.max(time, zone.shrink_end)) > reserve) return Infinity
  let low = Math.max(time, zone.shrink_start)
  let high = Math.max(low, zone.shrink_end)
  for (let i = 0; i < 12; i++) {
    const middle = (low + high) / 2
    if (zoneMargin(zone, point, middle) > reserve) low = middle
    else high = middle
  }
  return high
}
