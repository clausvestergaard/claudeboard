/**
 * Pure transition-detection for needs_input notifications.
 *
 * Given the previous status map and the current filtered sessions, compute:
 *   - toNotify: sessions that just transitioned INTO needs_input
 *   - badgeCount: number of needs_input sessions
 *   - nextMap: the map to carry into the next scan
 *
 * On the first scan (seed === true), no notifications fire — the map is
 * merely seeded. Legacy sessions never notify. Sessions absent from the
 * current results are dropped from the map.
 */

/**
 * @typedef {Object} DiffSession
 * @property {string} sessionId
 * @property {string} status
 * @property {boolean} [legacy]
 */

/**
 * @param {Map<string, string>} prevMap sessionId -> last-seen status
 * @param {DiffSession[]} sessions current filtered sessions
 * @param {boolean} seed true on the very first scan (suppress notifications)
 * @returns {{toNotify: DiffSession[], badgeCount: number, nextMap: Map<string, string>}}
 */
function diffStatuses(prevMap, sessions, seed) {
  const nextMap = new Map();
  const toNotify = [];
  let badgeCount = 0;

  for (const s of sessions) {
    const prev = prevMap.get(s.sessionId);
    nextMap.set(s.sessionId, s.status);

    if (s.status === "needs_input") {
      badgeCount++;
      if (
        !seed &&
        !s.legacy &&
        prev !== "needs_input"
      ) {
        toNotify.push(s);
      }
    }
  }

  return { toNotify, badgeCount, nextMap };
}

module.exports = { diffStatuses };
