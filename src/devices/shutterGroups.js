// -----------------------------------------------------------------------------
// Shutter groups: a group shows what its shutters show.
//
// A group is an emitter of its own on airsend.cloud ("All the south side",
// "Everything"): its own address, which every motor of the group was paired
// with. The integration knows a shutter belongs to it because the shutter lists
// that address in its `remotes` — it is how the shutter follows the group's
// orders. A group of groups works the same way: the group "South" lists
// "Everything" in its `remotes`.
//
// Orders flow down: closing the group closes its shutters. Nothing flowed back
// up. Raise every shutter of the house one by one, and "Everything" still said
// "closed"; lower one shutter of the south side, and "South" still said "open".
// The radio cannot say anything about it — a group is not a motor, nobody
// answers on its address — but the integration knows what it showed for every
// shutter of the group, and that is what the group shows here:
//   - every shutter open: the group is open, every shutter closed: closed;
//   - anything else (some open, some closed, one stopped half-way): the group
//     is neither. Gladys spells that "stopped", like a shutter in between.
//   - a group with a position (timed, or type 4099) shows the average position
//     of its shutters, when every one of them has one.
// Nothing of this goes on the air.
//
// Only the shutters of the group count, never the groups in between: "Every-
// thing" is the eight shutters of the house, whether they are listed under it
// directly or through "South", "West" and "North".
//
// A group is recomputed a moment after its shutters are done changing, not at
// every one of them: the shutters of a group follow its order one after the
// other, and in between the group would have been shown "stopped" for a
// fraction of a second — a state in its history, a scene run for nothing.
// -----------------------------------------------------------------------------

import { isSameChannel } from '../devmel/notes.js';

/**
 * How long the shutters of a group must have been quiet before the group is
 * recomputed, in milliseconds. A moving shutter publishes its position every
 * second or so: a group of moving shutters waits for the end of the movement.
 */
export const GROUP_SETTLE_MS = 2000;

export class ShutterGroups {
  /**
   * @param {object} options
   * @param {() => { now: Function, timers: { set: Function, clear: Function } }} options.clock
   *   where the timers come from (the travel's, so the tests drive both)
   * @param {(gladys: object, group: object, shown: Map) => Promise<void>} options.refresh
   *   what to do once a group's shutters are quiet: recompute and publish it
   */
  constructor({ clock, refresh }) {
    this.clock = clock;
    this.refresh = refresh;
    /** @type {Array<object>} the shutters of the configuration */
    this.devices = [];
    /** @type {Map<string, Array<object>>} the groups each shutter is in, by platform id */
    this.groupsOf = new Map();
    /** @type {Map<string, Array<object>>} the shutters of each group, by platform id */
    this.membersOf = new Map();
    /** @type {Map<string, {state?: number, position?: number}>} what Gladys was shown */
    this.shown = new Map();
    /** @type {Map<string, *>} a recomputation waiting for its group to settle */
    this.pending = new Map();
  }

  /**
   * The shutters of the configuration, and who is in which group. Called on
   * every configuration applied: a group is found again from the `remotes`
   * of its shutters, and what was shown is kept.
   *
   * @param {Array<object>} devices every shutter of the configuration
   */
  configure(devices) {
    this.cancel();
    this.devices = devices;
    const direct = new Map();
    for (const group of devices) {
      const members = devices.filter(
        (candidate) =>
          candidate !== group &&
          hasAddress(group.channel) &&
          (candidate.remotes ?? []).some((remote) => isSameChannel(group.channel, remote)),
      );
      if (members.length > 0) {
        direct.set(group.platformId, members);
      }
    }
    this.membersOf = new Map();
    this.groupsOf = new Map();
    for (const group of devices) {
      if (!direct.has(group.platformId)) {
        continue;
      }
      const shutters = leavesOf(group, direct);
      if (shutters.length === 0) {
        continue;
      }
      this.membersOf.set(group.platformId, shutters);
      for (const member of shutters) {
        const groups = this.groupsOf.get(member.platformId) ?? [];
        groups.push(group);
        this.groupsOf.set(member.platformId, groups);
      }
    }
  }

  /** Is this device a group of shutters? */
  isGroup(device) {
    return this.membersOf.has(device.platformId);
  }

  /** The shutters of a group (never the groups in between). */
  members(group) {
    return this.membersOf.get(group.platformId) ?? [];
  }

  /**
   * Gladys was just shown a value for this device: remember it, and when the
   * device is a shutter of a group, recompute the group once things settle.
   * The very value a group shows for itself (its own order) recomputes
   * nothing: its shutters follow that order, and THEY say what came of it.
   */
  record(gladys, device, values) {
    const before = this.shown.get(device.platformId) ?? {};
    this.shown.set(device.platformId, { ...before, ...values });
    for (const group of this.groupsOf.get(device.platformId) ?? []) {
      this.schedule(gladys, group);
    }
  }

  /** What Gladys was last shown for a device, without recomputing anything. */
  remember(device, values) {
    const before = this.shown.get(device.platformId) ?? {};
    this.shown.set(device.platformId, { ...before, ...values });
  }

  /** What Gladys was last shown for a device. */
  shownFor(device) {
    return this.shown.get(device.platformId) ?? {};
  }

  /** Recompute this group once its shutters have been quiet a moment. */
  schedule(gladys, group) {
    const { timers } = this.clock();
    const waiting = this.pending.get(group.platformId);
    if (waiting !== undefined) {
      waiting.timers.clear(waiting.handle);
    }
    const handle = timers.set(() => {
      this.pending.delete(group.platformId);
      this.refresh(gladys, group).catch(() => {});
    }, GROUP_SETTLE_MS);
    this.pending.set(group.platformId, { handle, timers });
  }

  /** Drop every recomputation still waiting (new configuration, shutdown). */
  cancel() {
    for (const { handle, timers } of this.pending.values()) {
      timers.clear(handle);
    }
    this.pending.clear();
  }

  /**
   * What the group shows, from what its shutters show: `state` (open, closed,
   * or "stopped" when they disagree) and `position` (the average), each
   * `undefined` when a shutter of the group has never shown one; `together`
   * is the position they all share, `null` when they are not all in one place.
   */
  aggregate(group) {
    const members = this.members(group).map((member) => this.shownFor(member));
    const states = members.map((shown) => shown.state);
    const positions = members.map((shown) => shown.position);
    const state = states.every(Number.isFinite)
      ? states.every((value) => value === states[0])
        ? states[0]
        : MIXED
      : undefined;
    const position =
      positions.length > 0 && positions.every(Number.isFinite)
        ? Math.round(positions.reduce((sum, value) => sum + value, 0) / positions.length)
        : undefined;
    const together =
      position === undefined
        ? undefined
        : positions.every((value) => value === positions[0])
          ? positions[0]
          : null;
    return { state, position, together };
  }
}

/** Gladys' "stopped": a group whose shutters are not all in the same place. */
const MIXED = 0;

/** The shutters under a group, through the groups in between, each once. */
function leavesOf(group, direct, seen = new Set([group.platformId])) {
  const leaves = [];
  for (const member of direct.get(group.platformId) ?? []) {
    if (seen.has(member.platformId)) {
      continue;
    }
    seen.add(member.platformId);
    if (direct.has(member.platformId)) {
      leaves.push(...leavesOf(member, direct, seen));
    } else {
      leaves.push(member);
    }
  }
  return leaves;
}

/**
 * A `remotes` line names a group by its address. A device with none (a
 * protocol alone) is no group: every shutter following "any frame of that
 * protocol" is not its member.
 */
function hasAddress(channel) {
  return channel?.source !== undefined && channel?.source !== null;
}
