/* Scoop circles: a few people who walk together at the same time each week.
 *
 * Start a circle (name, day, time, meeting point, weekly goal), invite people
 * with a link, say whether you're coming, check in at the meeting point,
 * walk together (hex ids shared live over Supabase Realtime, never tracks),
 * then give kudos and book the same time next week. Reminders come an hour
 * before (a notification in the Android app, a banner on the map).
 *
 * Joining a circle doesn't make you friends: friendships still last a month
 * unless you both renew, and a circle walk shows the Renew chip for friends
 * who are due. Built on what social.js shares in window.scoopKit.
 */
(() => {
  'use strict';

  const S = window.scoop;
  const kit = window.scoopKit;
  const core = window.ScoopCore;
  if (!S || !kit || !core || !window.h3) return;

  const { sb, check, fail, h, fill, sheetHead, avatar, fmtKm } = kit;
  const { toast } = S;
  const $ = (id) => document.getElementById(id);
  const LN = S.LocalNotifications;

  const INVITE_KEY = 'scoop.circleInvite';
  const BANNER_HIDDEN_KEY = 'scoop.circleBannerHidden.v1';
  const SOLO_KEY = 'scoop.soloWalk.v1';
  const NOTIFY_ASKED_KEY = 'scoop.circleNotifyAsked.v1';
  const REFRESH_MS = 2 * 60000;
  const POLL_MS = 8000;
  const PUSH_MS = 5000;
  const REMIND_BEFORE_MS = 3600000;
  const REMIND_ID = 7000000;     // + session id: one reminder per walk
  const SOLO_ID = 7999999;
  const MEET_MAX_ACCURACY = 60;  // metres: the server checks the ~1 km² block, so this needn't be tight
  const TIMES = ['07:00', '18:00', '20:30'];
  const GOALS = [15, 30, 50];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function saveJSON(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // Storage blocked: the banner may show again, nothing worse.
    }
  }

  const me = () => kit.uid();
  const place = (c) => c.meet_label || c.district_name || 'the meeting point';
  const fmtWhen = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const isAre = (n) => (n === 1 ? 'is' : 'are');
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  // "4.6 km", "0 km": a goal reads in whole tenths.
  const kmWord = (n) => `${Math.round((Number(n) || 0) * 10) / 10}`;
  // "Nour's", "Tuesday Walkers'"
  const possessive = (name) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);
  const hexWord = (n) => (n === 1 ? '1 hex' : `${n.toLocaleString()} hexes`);

  /** @type {object[]} my_circles(), with next.starts in ms */
  let circles = [];
  /** @type {object[]} my_guest_walks() */
  let guestWalks = [];
  let loading = null;
  /** Which view the circle sheet shows, so polls and reloads redraw the right thing. */
  let view = null;

  function normalise(c) {
    const next = c.next ? { ...c.next, starts: Date.parse(c.next.starts_at), people: c.next.people || [] } : null;
    return { ...c, id: Number(c.id), members: c.members || [], next: next && { ...next, id: Number(next.id) },
      week_km: Number(c.week_km) || 0, goal_km: Number(c.goal_km) || 30, streak: Number(c.streak) || 0 };
  }

  async function loadCircles() {
    if (!kit.profile) {
      circles = [];
      guestWalks = [];
      afterLoad();
      return circles;
    }
    if (loading) return loading;
    loading = (async () => {
      try {
        const [rows, guests] = await Promise.all([sb.rpc('my_circles').then(check), sb.rpc('my_guest_walks').then(check)]);
        circles = rows.map(normalise);
        guestWalks = guests.map((g) => ({ ...g, session: Number(g.session), starts: Date.parse(g.starts_at) }));
      } catch (err) {
        // Offline: keep what we had.
      } finally {
        loading = null;
      }
      afterLoad();
      return circles;
    })();
    return loading;
  }

  function afterLoad() {
    updateBanner();
    scheduleReminders();
    if (S.currentSheet() === 'meSheet') renderMeRow();
  }

  const byId = (id) => circles.find((c) => c.id === Number(id));
  const myPerson = (c) => (c && c.next ? c.next.people.find((p) => p.id === me()) : null);
  const rsvpOf = (c) => (myPerson(c) || {}).rsvp || null;
  const checkedIn = (c) => !!(myPerson(c) || {}).checked_in;
  const isOwner = (c) => c.role === 'owner';

  async function call(fn, args) {
    return check(await sb.rpc(fn, args));
  }

  function show(render) {
    view = render;
    if (S.currentSheet() !== 'circleSheet') S.openSheet('circleSheet');
    return render();
  }
  const body = () => $('circleBody');
  const loadingView = () => fill(body(), h('span', { class: 'fine' }, 'Loading…'));

  // ---------- walk with people (the intro) ----------

  /** From "Walk with someone": your circle if you have one, else why and how. */
  async function openIntro() {
    if (!kit.profile) return kit.openSignIn();
    S.openSheet('circleSheet');
    loadingView();
    await loadCircles();
    if (circles.length) return show(() => renderHome(circles[0].id));
    return show(() => renderIntro({ step: 0 }));
  }

  async function renderIntro(state) {
    const hood = kit.hood();
    const where = kit.hoodName() || 'your area';
    let near = [];
    if (hood.id) {
      try {
        near = (await call('circles_near', { district: hood.id })).map((x) => ({ ...x, next_at: x.next_at && Date.parse(x.next_at) }));
      } catch (err) {
        // Offline: just offer to start one.
      }
    }
    const offer = near.find((x) => x.next_session && !x.asked);
    const dots = (n) => h('span', { class: 'circle-dots', 'aria-hidden': 'true' }, Array.from({ length: Math.min(5, n) }, () => h('span')));
    const list = near.length
      ? h('div', { class: 'stack tight' },
        h('span', { class: 'label' }, `${plural(near.length, 'circle')} welcome guests in ${where}`),
        h('div', { class: 'list-card' }, near.map((x) => h('div', { class: 'list-row' },
          dots(Number(x.size)),
          h('span', {}, h('b', {}, `A circle of ${x.size}`), ` · ${core.circleSchedule(x.weekday, x.at_time)}`),
          x.asked ? h('span', { class: 'row-val' }, x.asked === 'yes' ? "you're going" : 'asked') : null))))
      : h('span', { class: 'body' }, `No circles in ${where} welcome guests yet. Start the first one.`);

    let actions;
    if (state.step === 1 && offer) {
      const day = core.WEEKDAYS[offer.weekday];
      actions = h('div', { class: 'guest-offer' },
        h('b', {}, 'No rush. Try one as a guest?'),
        h('span', { class: 'body' }, `The ${day} circle of ${offer.size} welcomes guests. No commitment, and they only see your first name.`),
        h('button', {
          class: 'btn md friend',
          onclick: async () => {
            try {
              await call('ask_to_join', { session: offer.next_session });
              await loadCircles();
              renderIntro({ step: 2, day });
            } catch (err) {
              fail(err);
            }
          },
        }, `Ask to join ${day}'s walk`),
        h('button', { class: 'btn ghost', onclick: () => renderIntro({ step: 0 }) }, 'Back'));
    } else if (state.step === 2) {
      actions = [
        h('div', { class: 'note-row' }, h('span', { class: 'dot friend' }),
          h('span', {}, h('b', {}, 'Asked. '), `You'll hear back before ${state.day}, and the walk will show up in Me.`)),
        h('button', { class: 'btn', onclick: () => show(() => renderSetup(null)) }, 'Start my own circle too'),
      ];
    } else {
      actions = [
        h('button', { class: 'btn', onclick: () => show(() => renderSetup(null)) }, 'Start a circle'),
        h('button', { class: 'btn ghost', onclick: () => (offer ? renderIntro({ step: 1 }) : S.closeSheet()) }, 'Maybe later'),
      ];
    }

    fill(body(), h('div', { class: 'stack' },
      h('div', { class: 'sheet-head' },
        h('div', { class: 'stack tight', style: 'gap:2px' },
          h('span', { class: 'kicker' }, 'Next first · walk with someone'),
          h('span', { class: 'sheet-title' }, "Walks stick when someone's expecting you")),
        h('button', { class: 'icon-btn sm', 'data-close': true, 'aria-label': 'Close' }, '✕')),
      h('div', { class: 'panel friend' },
        h('span', { class: 'body' }, 'A circle is 2 to 8 people who walk at the same time each week. You meet, check in together and warm the map as one.')),
      list,
      guestWalksBlock(),
      actions,
      h('span', { class: 'fine' }, 'Circle members see whether you walked each week, never when or where. They only see your first name.')));
  }

  function guestWalksBlock() {
    if (!guestWalks.length) return null;
    return h('div', { class: 'stack tight' },
      h('span', { class: 'label' }, 'Walks you asked to join'),
      h('div', { class: 'list-card' }, guestWalks.map((g) => h('div', { class: 'list-row' },
        h('span', { dir: 'auto' }, g.approved ? `${g.circle_name} · ${place(g)}` : 'A circle walk'),
        h('span', { class: g.approved ? 'row-val accent' : 'row-val' }, g.approved ? fmtWhen(g.starts) : `${fmtWhen(g.starts)} · waiting`)))));
  }

  // ---------- setting a circle up ----------

  /** Where your last walk ended: the hex you walked most recently. */
  function lastWalkedCell() {
    let best = null;
    let at = -1;
    for (const [c, t] of S.lastSeen) if (t > at) { best = c; at = t; }
    return best;
  }

  function setupDefaults() {
    const last = S.walks.length ? new Date(S.walks[S.walks.length - 1].start) : new Date();
    const weekday = last.getDay();
    const mins = Math.round((last.getHours() * 60 + last.getMinutes()) / 30) * 30 % (24 * 60);
    const at = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    const cell = lastWalkedCell() || kit.hereCell();
    const d = cell ? kit.districtOf(latLngOf(cell)) : null;
    return {
      name: `${core.WEEKDAYS[weekday]} Walkers`, weekday, at, cell, from: 'last',
      label: d ? d.name : '', goal: 30, guests: false,
    };
  }

  function latLngOf(cell) {
    const [lat, lng] = h3.cellToLatLng(cell);
    return { lat, lng };
  }

  function renderSetup(editing, state = null) {
    const f = state || (editing ? {
      name: editing.name, weekday: editing.weekday, at: editing.at_time, cell: editing.meet_cell, from: 'circle',
      label: editing.meet_label || '', goal: editing.goal_km, guests: editing.guests,
    } : setupDefaults());
    const redo = () => renderSetup(editing, f);
    const nameIn = h('input', { class: 'input note', value: f.name, maxlength: '30', dir: 'auto', 'aria-label': 'Circle name' });
    nameIn.addEventListener('input', () => { f.name = nameIn.value; });
    const labelIn = h('input', { class: 'input note', value: f.label, maxlength: '60', dir: 'auto', placeholder: 'Name the spot, e.g. "Corniche steps"', 'aria-label': 'Meeting point name' });
    labelIn.addEventListener('input', () => { f.label = labelIn.value; });
    const times = TIMES.includes(f.at) ? TIMES : [...TIMES, f.at].sort();
    const otherTime = h('input', { class: 'input time', type: 'time', value: f.at, 'aria-label': 'Another time' });
    otherTime.addEventListener('change', () => { if (/^\d\d:\d\d$/.test(otherTime.value)) { f.at = otherTime.value; redo(); } });
    const chip = (label, on, pick, aria) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(on), 'aria-label': aria || label, onclick: pick }, label);
    const hidden = f.cell && kit.isHidden(f.cell);
    const useHere = () => {
      const cell = kit.hereCell();
      if (!cell) { toast('Finding you…'); S.locate(); return; }
      if (kit.isHidden(cell)) { toast("You're in a privacy zone · pick a spot outside it"); return; }
      f.cell = cell;
      f.from = 'here';
      const d = kit.districtOf(latLngOf(cell));
      if (!f.label && d) f.label = d.name;
      redo();
    };
    const guestsRow = h('button', {
      type: 'button', class: 'toggle-row', role: 'switch', 'aria-checked': String(!!f.guests),
      onclick: () => { f.guests = !f.guests; guestsRow.setAttribute('aria-checked', String(f.guests)); },
    }, h('span', {}, 'Welcome guests',
      h('small', {}, `List it in ${kit.hoodName() || 'your district'} by size and time only. You say yes to each guest.`)),
    h('span', { class: 'switch' }, h('span')));

    const submit = async () => {
      f.name = nameIn.value.trim();
      f.label = labelIn.value.trim();
      if (!f.name) return toast('Give your circle a name');
      if (!f.cell) return toast('Pick a meeting point: tap Change where you want to meet');
      if (kit.isHidden(f.cell)) return toast("That's inside a privacy zone · pick a spot outside it");
      const args = {
        name: f.name, weekday: f.weekday, at_time: f.at, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        meet_cell: f.cell, meet_label: f.label || null, goal_km: f.goal, guests: !!f.guests,
      };
      try {
        if (editing) {
          await call('update_circle', { circle: editing.id, ...args });
          await loadCircles();
          toast('Circle updated');
          return show(() => renderHome(editing.id));
        }
        const id = Number(await call('create_circle', args));
        await loadCircles();
        askNotifications();
        kit.forgetFirsts();
        return showInvite(id);
      } catch (err) {
        return fail(err);
      }
    };

    fill(body(), h('div', { class: 'stack' },
      h('div', { class: 'sheet-head' },
        h('div', { class: 'stack tight', style: 'gap:2px' },
          h('span', { class: 'sheet-title' }, editing ? 'Change your circle' : 'Set up your circle'),
          editing ? null : h('span', { class: 'me-sub' }, 'We filled this in from your last walk.')),
        h('button', { class: 'icon-btn sm', 'data-close': true, 'aria-label': 'Close' }, '✕')),
      h('label', { class: 'field' }, 'Name', nameIn),
      h('div', { class: 'block' },
        h('span', { class: 'sublabel' }, 'Walk together on'),
        h('div', { class: 'chips' }, DAY_ORDER.map((d) => chip(core.WEEKDAYS[d].slice(0, 3), d === f.weekday, () => { f.weekday = d; redo(); }, core.WEEKDAYS[d]))),
        h('div', { class: 'chips' }, times.map((t) => chip(t, t === f.at, () => { f.at = t; redo(); })), otherTime)),
      h('div', { class: 'place-row' },
        h('span', { class: 'pin', 'aria-hidden': 'true' }, '📍'),
        h('div', {},
          h('b', {}, f.cell ? (hidden ? 'Inside a privacy zone' : 'Meeting point') : 'No meeting point yet'),
          h('small', {}, { last: 'Where your last walk ended', here: 'Where you are now', circle: 'Where you meet now' }[f.from] || '')),
        h('button', { type: 'button', class: 'link', onclick: useHere }, 'Use where I am')),
      labelIn,
      h('div', { class: 'block' },
        h('span', { class: 'sublabel' }, 'Shared goal each week'),
        h('div', { class: 'chips' }, GOALS.map((g) => chip(`${g} km`, g === Number(f.goal), () => { f.goal = g; redo(); }))),
        h('span', { class: 'fine' }, `Shared goal · ${f.goal} km a week together. Change it any time.`)),
      guestsRow,
      h('button', { class: 'btn', onclick: submit }, editing ? 'Save' : 'Next · invite people')));
  }

  // ---------- inviting ----------

  let invitePoll = null;

  function renderInvite(id, shared = false) {
    clearTimeout(invitePoll);
    const c = byId(id);
    if (!c) return renderIntro({ step: 0 });
    const others = c.members.filter((m) => !m.me);
    const text = `Walk ${c.district_name || 'the neighbourhood'} with me on ${core.WEEKDAYS[c.weekday]}s at ${c.at_time}? ` +
      `We start at ${place(c)} and light up the map together. Join ${c.name} on Scoop`;
    const url = `${kit.PUBLIC_URL}?circle=${c.code}`;
    let status = null;
    if (others.length) {
      const newest = others[others.length - 1];
      status = h('div', { class: 'joined-row' },
        avatar(newest.name, 'friend'),
        h('div', {}, h('b', { dir: 'auto' }, `${newest.name} joined ${c.name}`),
          h('small', {}, `+${core.CHECKIN_KINDS.meetup.points} each when you check in together`)));
    } else if (shared) {
      status = h('div', { class: 'note-row' }, h('span', { class: 'dot friend pulse' }), h('span', {}, 'Invite shared · waiting for someone to join'));
      // Keep looking while this is on screen.
      invitePoll = setTimeout(async () => {
        if (view && S.currentSheet() === 'circleSheet') {
          await loadCircles();
          if (view.invite === id) renderInvite(id, true);
        }
      }, POLL_MS);
    }
    const share = async () => {
      try {
        await kit.shareText(`Join ${c.name} on Scoop`, text, url);
        renderInvite(id, true);
      } catch (err) {
        if (!kit.cancelled(err)) fail(err);
      }
    };
    fill(body(), h('div', { class: 'stack' },
      h('div', { class: 'sheet-head' },
        h('div', { class: 'stack tight', style: 'gap:2px' },
          h('span', { class: 'sheet-title' }, others.length ? 'Invite more people' : 'Invite 2 people you\u2019d walk with'),
          h('span', { class: 'me-sub' }, "They'll get this. You can edit it before sending.")),
        h('button', { class: 'icon-btn sm', 'data-close': true, 'aria-label': 'Close' }, '✕')),
      h('div', { class: 'invite-preview', dir: 'auto' }, text, h('span', { class: 'link-line' }, url)),
      status,
      h('button', { class: others.length ? 'btn outline' : 'btn', onclick: share }, shared ? 'Share again' : 'Share invite'),
      others.length || shared ? h('button', { class: 'btn', onclick: () => show(() => renderHome(id)) }, 'Continue') : null,
      h('span', { class: 'fine' }, 'We never look at your contacts. Circle members see whether you walked each week, never when or where.')));
  }
  function showInvite(id) {
    const v = () => renderInvite(id);
    v.invite = id;
    return show(v);
  }

  // ---------- a circle ----------

  const STATUS = { in: 'in', omw: 'on the way', out: "can't make it" };

  function peopleOn(c) {
    const next = c.next;
    const byPerson = new Map((next ? next.people : []).map((p) => [p.id, p]));
    const rows = c.members.map((m) => ({ ...m, ...(byPerson.get(m.id) || {}), name: m.name, member: true }));
    for (const p of next ? next.people : []) if (p.guest && p.approved) rows.push({ ...p, member: false });
    return rows;
  }

  function personStatus(p) {
    if (p.checked_in) return 'checked in';
    if (p.rsvp) return STATUS[p.rsvp];
    return 'no answer yet';
  }

  async function rsvp(c, answer) {
    try {
      await call('rsvp', { session: c.next.id, answer });
      if (answer !== 'out') askNotifications();
      await loadCircles();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  }

  function renderHome(id) {
    const c = byId(id);
    if (!c) return circles.length ? renderHome(circles[0].id) : renderIntro({ step: 0 });
    const next = c.next;
    const goalPct = Math.min(100, Math.round((c.week_km / c.goal_km) * 100));
    const mine = rsvpOf(c);
    const pending = next && isOwner(c) ? next.people.filter((p) => p.guest && !p.approved) : [];

    const nextCard = next ? h('div', { class: 'circle-next' },
      h('div', { class: 'top' },
        h('b', {}, fmtWhen(next.starts)),
        h('span', { class: 'sub' }, core.walkWhen(next.starts) || place(c))),
      h('div', { class: 'people' }, peopleOn(c).map((p) => h('div', { class: `person-line${p.checked_in ? ' on' : ''}` },
        avatar(p.name, p.me || p.id === me() ? 'me sm' : 'friend sm'),
        h('span', { dir: 'auto' }, p.id === me() ? 'You' : p.name, p.member ? null : h('small', {}, ' · guest')),
        h('span', { class: 'status' }, personStatus(p))))),
      core.checkInOpen(next.starts) && !checkedIn(c)
        ? h('button', { class: 'btn md', onclick: () => showMeetup(c.id) }, 'Check in at the meeting point')
        : checkedIn(c) ? h('button', { class: 'btn md', onclick: () => showMeetup(c.id) }, 'Meet up') : null,
      checkedIn(c) ? null : h('div', { class: 'btn-row' },
        h('button', { class: 'chip rsvp', 'aria-pressed': String(mine === 'in' || mine === 'omw'), onclick: async () => { if (await rsvp(c, 'in')) renderHome(id); } }, "I'm in"),
        h('button', { class: 'chip rsvp', 'aria-pressed': String(mine === 'out'), onclick: async () => { if (await rsvp(c, 'out')) show(() => renderCant(id)); } }, "Can't make it")))
      : h('div', { class: 'circle-next' },
        h('span', { class: 'body' }, 'No walk booked yet.'),
        h('button', {
          class: 'btn md',
          onclick: async () => {
            try {
              await call('book_next', { circle: c.id });
              await loadCircles();
              renderHome(id);
            } catch (err) {
              fail(err);
            }
          },
        }, `Book ${core.circleSchedule(c.weekday, c.at_time).replace(/s /, ' ')}`));

    fill(body(), h('div', { class: 'stack' },
      h('div', { class: 'sheet-head' },
        h('div', { class: 'stack tight', style: 'gap:2px' },
          h('span', { class: 'sheet-title', dir: 'auto' }, c.name),
          h('span', { class: 'me-sub', dir: 'auto' }, `${core.circleSchedule(c.weekday, c.at_time)} · ${place(c)}`)),
        h('button', { class: 'icon-btn sm', 'data-close': true, 'aria-label': 'Close' }, '✕')),
      h('div', { class: 'panel friend' },
        h('div', { class: 'streak-line' },
          h('b', {}, c.streak ? `Circle streak · ${plural(c.streak, 'week')}` : 'No streak yet'),
          h('span', { class: 'sub' }, c.skip_used ? "This month's free skip is used" : 'One free skip left this month')),
        h('div', { class: 'progress friend', role: 'img', 'aria-label': `${goalPct}% of the weekly goal` },
          h('div', { class: 'progress-fill', style: `width:${goalPct}%` })),
        h('span', { class: 'sub' }, `${kmWord(c.week_km)} of ${kmWord(c.goal_km)} km together this week`)),
      nextCard,
      pending.length ? h('div', { class: 'stack tight' },
        h('span', { class: 'label' }, 'Asking to come along'),
        h('div', { class: 'list-card' }, pending.map((p) => h('div', { class: 'list-row' },
          h('span', { dir: 'auto' }, p.name),
          h('button', { class: 'chip status ok', onclick: () => answerGuest(c, p, true) }, 'Say yes'),
          h('button', { class: 'link danger', onclick: () => answerGuest(c, p, false) }, 'No'))))) : null,
      h('div', { class: 'stack tight' },
        h('span', { class: 'label' }, `Members · ${c.members.length}`),
        h('div', { class: 'list-card' }, c.members.map((m) => h('div', { class: 'list-row' },
          h('span', { dir: 'auto' }, m.me ? 'You' : m.name, m.role === 'owner' ? h('small', { class: 'muted' }, ' · started it') : null),
          h('span', { class: m.walked_week ? 'row-val friend' : 'row-val' }, m.walked_week ? 'walked this week' : 'not yet this week'))))),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn outline', onclick: () => showInvite(c.id) }, 'Invite someone'),
        isOwner(c) ? h('button', { class: 'btn outline', onclick: () => show(() => renderSetup(c)) }, 'Change') : null),
      h('button', { class: 'link danger', onclick: () => leave(c) }, 'Leave circle'),
      h('span', { class: 'fine' }, 'Members see whether you walked each week, never when or where. A week counts when two of you check in together; every circle gets one free skip a month.')));
  }

  async function answerGuest(c, p, accept) {
    try {
      await call('answer_guest', { session: c.next.id, guest: p.id, accept });
      toast(accept ? `${p.name} can come along` : `Told ${p.name} not this time`);
      await loadCircles();
      renderHome(c.id);
    } catch (err) {
      fail(err);
    }
  }

  async function leave(c) {
    const others = c.members.length - 1;
    const ok = await S.confirmDialog({
      title: `Leave ${c.name}?`,
      body: others
        ? `You'll stop getting its reminders.${isOwner(c) ? ' The person who has been in it longest takes over.' : ''} You can come back with an invite.`
        : "You're the last one in it, so the circle goes too.",
      confirm: 'Leave circle',
    });
    if (ok !== 'confirm') return;
    try {
      await call('leave_circle', { circle: c.id });
      await loadCircles();
      toast(`Left ${c.name}`);
      S.closeSheet();
    } catch (err) {
      fail(err);
    }
  }

  // ---------- can't make it ----------

  function renderCant(id) {
    const c = byId(id);
    if (!c || !c.next) return renderHome(id);
    const others = core.whoIsIn(c.next.people, me());
    const when = core.walkWhen(c.next.starts) ? 'tonight' : `on ${fmtWhen(c.next.starts)}`;
    const solo = loadJSON(SOLO_KEY, null);
    if (solo && solo.session === c.next.id) return renderSolo(id);
    fill(body(), h('div', { class: 'stack' },
      h('div', { class: 'cant-card' },
        others.length ? h('div', { class: 'avatars' }, others.slice(0, 4).map((n) => avatar(n, 'friend'))) : null,
        h('span', { class: 'panel-title', dir: 'auto' }, others.length ? `${core.nameList(others)} know` : 'Got it'),
        h('span', { class: 'body' }, [
          others.length ? `They'll still walk ${when}.` : null,
          c.skip_used ? 'This week counts if two of you walk together.' : `${c.name} keeps its streak, because every circle gets one free skip a month.`,
        ].filter(Boolean).join(' '))),
      h('button', { class: 'btn', onclick: () => { saveSolo(c); show(() => renderSolo(id)); } }, 'Walk solo tomorrow instead'),
      h('button', { class: 'btn ghost', onclick: async () => { if (await rsvp(c, 'in')) show(() => renderHome(id)); } }, "Undo, I'll come")));
  }

  /** Tomorrow, at the circle's time. */
  function soloAt(c) {
    const t = new Date(c.next.starts);
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(t.getHours(), t.getMinutes(), 0, 0);
    return d.getTime();
  }

  function saveSolo(c) {
    const at = soloAt(c);
    saveJSON(SOLO_KEY, { at, session: c.next.id, district: c.district_name || null });
    if (LN) {
      LN.schedule({ notifications: [{
        id: SOLO_ID, title: 'Your solo walk',
        body: `${c.district_name || 'Your neighbourhood'} could use a walk. Tap to start.`,
        schedule: { at: new Date(at), allowWhileIdle: true }, extra: { kind: 'solo' },
      }] }).catch(() => {});
    }
    updateBanner();
  }

  function cancelSolo() {
    saveJSON(SOLO_KEY, null);
    if (LN) LN.cancel({ notifications: [{ id: SOLO_ID }] }).catch(() => {});
    updateBanner();
  }

  function renderSolo(id) {
    const c = byId(id);
    const solo = loadJSON(SOLO_KEY, null);
    if (!solo) return renderCant(id);
    fill(body(), h('div', { class: 'stack' },
      h('div', { class: 'cant-card' },
        h('span', { class: 'panel-title' }, `Saved for tomorrow at ${fmtTime(solo.at)}`),
        h('span', { class: 'body' }, `We'll remind you once. A solo walk still warms ${solo.district || 'the neighbourhood'}.`)),
      h('button', { class: 'btn', 'data-close': true }, 'Done'),
      h('button', { class: 'btn ghost', onclick: () => { cancelSolo(); show(() => (c ? renderCant(id) : null)); } }, 'Undo')));
  }

  // ---------- meeting up ----------

  let meetPoll = null;

  function renderMeetup(id) {
    clearTimeout(meetPoll);
    const c = byId(id);
    if (!c || !c.next) return renderHome(id);
    const people = peopleOn(c).sort((a, b) => Number(!!b.checked_in) - Number(!!a.checked_in));
    const here = people.filter((p) => p.checked_in).length;
    const mineIn = checkedIn(c);
    const checkIn = async () => {
      const pos = S.position();
      if (!pos) { toast('Finding you…'); S.locate(); return; }
      if (pos.accuracy > MEET_MAX_ACCURACY) { toast(`Waiting for a better location (±${Math.round(pos.accuracy)} m)`); return; }
      try {
        const rows = await call('circle_check_in', { session: c.next.id, cell: kit.hereCell() });
        kit.forgetFirsts();
        if (rows.length >= 2) toast(`🤝 Meetup verified · +${core.CHECKIN_KINDS.meetup.points} pts each`, 4000);
        await loadCircles();
        renderMeetup(id);
      } catch (err) {
        fail(err);
      }
    };
    if (mineIn && here < 2) {
      meetPoll = setTimeout(async () => {
        if (S.currentSheet() !== 'circleSheet') return;
        await loadCircles();
        if (view && view.meetup === id) renderMeetup(id);
      }, POLL_MS);
    }
    fill(body(), h('div', { class: 'stack' },
      h('div', { class: 'sheet-head' },
        h('div', { class: 'stack tight', style: 'gap:2px' },
          h('span', { class: 'sheet-title' }, 'Check in here'),
          h('span', { class: 'me-sub', dir: 'auto' }, `${place(c)} · ${possessive(c.name)} meeting point`)),
        h('button', { class: 'icon-btn sm', 'data-close': true, 'aria-label': 'Close' }, '✕')),
      h('div', { class: 'people' }, people.map((p) => h('div', { class: `person-line${p.checked_in ? ' on' : ''}` },
        avatar(p.name, p.id === me() ? 'me sm' : 'friend sm'),
        h('span', { dir: 'auto' }, p.id === me() ? 'You' : p.name),
        h('span', { class: 'status' }, p.checked_in ? 'checked in here' : personStatus(p))))),
      !mineIn
        ? [h('button', { class: 'btn', onclick: checkIn }, 'Check in for the meetup'),
          h('span', { class: 'fine' }, `+${core.CHECKIN_KINDS.meetup.points} pts each once two of you have checked in.`)]
        : here >= 2
          ? [h('div', { class: 'verified' }, `🤝 Meetup verified · +${core.CHECKIN_KINDS.meetup.points} pts each`),
            h('button', { class: 'btn', onclick: () => startTogether(c) }, S.walking() ? 'Walk together' : 'Start walking together')]
          : h('div', { class: 'note-row' }, h('span', { class: 'dot friend pulse' }), h('span', {}, 'Checked in · waiting for the others'))));
  }
  function showMeetup(id) {
    const v = () => renderMeetup(id);
    v.meetup = id;
    return show(v);
  }

  // ---------- walking together (Realtime) ----------

  /** @type {null|{c:object, session:number, channel:object, cells:Object<string,Set<string>>, km:Object<string,number>, sent:Set<string>, walking:Set<string>, names:Object<string,string>, timer:number, lastKm:number}} */
  let live = null;
  let wantTogether = null;
  /** The circle walk that just ended, for the walk summary. */
  let lastTogether = null;

  function startTogether(c) {
    wantTogether = c.id;
    S.closeSheet();
    if (S.walking()) joinLive(c);
    else S.startWalk();
  }

  /** The circle walk you could be on now: checked in, and within its time. */
  function currentCircle() {
    if (wantTogether) return byId(wantTogether);
    return circles.find((c) => c.next && checkedIn(c) && core.checkInOpen(c.next.starts)) || null;
  }

  async function joinLive(c) {
    if (live || !c || !c.next) return;
    wantTogether = null;
    const names = {};
    for (const p of peopleOn(c)) names[p.id] = p.name;
    const channel = sb.channel(`circle-session:${c.next.id}`, {
      config: { private: true, broadcast: { self: false }, presence: { key: me() } },
    });
    live = { c, session: c.next.id, channel, cells: { [me()]: new Set() }, km: { [me()]: 0 }, sent: new Set(), walking: new Set([me()]), names, timer: 0, lastKm: -1 };
    try {
      if (sb.realtime && sb.realtime.setAuth) await sb.realtime.setAuth();
    } catch (err) {
      // Older clients pick the token up on their own.
    }
    channel
      .on('broadcast', { event: 'hexes' }, ({ payload }) => {
        if (!live || !payload || typeof payload.u !== 'string' || payload.u === me()) return;
        const set = live.cells[payload.u] || (live.cells[payload.u] = new Set());
        for (const cell of (Array.isArray(payload.cells) ? payload.cells : []).slice(0, 3000)) {
          if (typeof cell === 'string' && /^8a[0-9a-f]{13}$/.test(cell)) set.add(cell);
        }
        live.km[payload.u] = Math.max(0, Math.min(300, Number(payload.km) || 0));
        renderTogether();
      })
      .on('presence', { event: 'sync' }, () => {
        if (!live) return;
        live.walking = new Set([me(), ...Object.keys(channel.presenceState())]);
        renderTogether();
      })
      // Someone joined late: send them everything so far.
      .on('presence', { event: 'join' }, () => push(true))
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          try { await channel.track({ at: Date.now() }); } catch (err) { /* presence is a nicety */ }
          push(true);
        }
      });
    live.timer = setInterval(() => push(false), PUSH_MS);
    renderTogether();
  }

  /** Send the hexes this walk counted since last time (all of them with `all`), never ones in privacy zones. */
  function push(all) {
    if (!live) return;
    const stats = S.walkStats();
    if (!stats) return;
    const mine = stats.cells.filter((c) => !kit.isHidden(c));
    live.cells[me()] = new Set(mine);
    live.km[me()] = stats.km;
    const fresh = all ? mine : mine.filter((c) => !live.sent.has(c));
    if (!fresh.length && Math.abs(stats.km - live.lastKm) < 0.01) return;
    for (const c of fresh) live.sent.add(c);
    live.lastKm = stats.km;
    live.channel.send({ type: 'broadcast', event: 'hexes', payload: { u: me(), cells: fresh.slice(-3000), km: +stats.km.toFixed(3) } })
      .catch(() => {});
    renderTogether();
  }

  function liveTotals() {
    const hexes = core.togetherHexes(live.cells);
    const km = Object.values(live.km).reduce((a, b) => a + (Number(b) || 0), 0);
    return { hexes, km };
  }

  function renderTogether() {
    const row = $('togetherRow');
    if (!row) return;
    if (!live) {
      row.hidden = true;
      fill(row);
      return;
    }
    const others = [...live.walking].filter((id) => id !== me()).map((id) => live.names[id] || 'Someone');
    const t = liveTotals();
    row.hidden = false;
    fill(row,
      h('span', { class: 'avatars' }, others.slice(0, 4).map((n) => avatar(n, 'friend sm'))),
      h('span', { class: 'together-text' }, others.length
        ? [h('b', {}, `+${t.hexes}`), ` hexes together · ${fmtKm(t.km)} km · with ${core.nameList(others)}`]
        : `${live.c.name} · waiting for the others to start walking`));
  }

  async function leaveLive() {
    if (!live) return;
    clearInterval(live.timer);
    try { await sb.removeChannel(live.channel); } catch (err) { /* gone anyway */ }
    live = null;
    renderTogether();
  }

  document.addEventListener('scoop:walk-start', () => {
    const c = currentCircle();
    if (c) joinLive(c);
  });

  document.addEventListener('scoop:walk-stop', (e) => {
    if (!live) return;
    const { walk, saved, cells } = e.detail;
    // The walk is over (walkStats() is empty now): take its final hexes from the event.
    const mineAll = (cells || []).filter((x) => !kit.isHidden(x));
    live.cells[me()] = new Set(mineAll);
    live.km[me()] = walk.km;
    live.channel.send({ type: 'broadcast', event: 'hexes', payload: { u: me(), cells: mineAll.filter((x) => !live.sent.has(x)), km: walk.km } })
      .catch(() => {});
    const together = { ...liveTotals(), heardOthers: Object.keys(live.cells).some((id) => id !== me() && live.cells[id].size) };
    const session = live.session;
    const c = live.c;
    const hexes = mineAll.length;
    lastTogether = {
      c, session, at: Date.now(), together, walk,
      logged: saved
        ? sb.rpc('log_circle_walk', { session, started: new Date(walk.start).toISOString(), km: Math.min(299, walk.km), hexes })
          .then(check).catch((err) => fail(err))
        : Promise.resolve(),
    };
    leaveLive();
  });

  // ---------- the circle walk, saved ----------

  document.addEventListener('scoop:summary', (e) => {
    const cw = lastTogether;
    if (!cw || Date.now() - cw.at > 60000) return;
    lastTogether = null;
    renderCircleSummary(cw, e.detail.walk);
  });

  async function renderCircleSummary(cw, walk) {
    const box = $('summaryExtra');
    if (!box) return;
    await cw.logged;
    let rows = [];
    let friends = [];
    try {
      [rows, friends] = await Promise.all([call('circle_walk', { session: cw.session }), kit.loadFriends().catch(() => [])]);
    } catch (err) {
      // Offline: show what the live walk knew.
    }
    await loadCircles();
    if (!$('summaryExtra') || S.currentSheet() !== 'summarySheet') return;
    const c = byId(cw.c.id) || cw.c;
    const friendOf = new Map(friends.map((r) => [r.other.id, r]));
    // Everyone's hexes, each once, when the live walk heard from the others; else the sum of what each logged.
    const logged = rows.reduce((a, r) => a + (Number(r.hexes) || 0), 0);
    const hexes = cw.together.heardOthers ? cw.together.hexes : Math.max(logged, cw.together.hexes);
    const draw = () => {
      fill($('summaryExtra'), h('div', { class: 'stack' },
        h('div', { class: 'welcome-card together' },
          h('span', { class: 'together-mark', 'aria-hidden': 'true' }, '🤝'),
          h('span', { class: 'title', dir: 'auto' }, `${c.name} warmed ${hexWord(hexes)}`),
          h('span', { class: 'sub' }, `Circle walk · ${fmtTime(walk.end)} · ${c.district_name ? `for ${c.district_name}` : 'together'}`)),
        h('div', { class: 'list-card walk-people' }, rows.map((r) => {
          const friend = friendOf.get(r.user_id);
          const due = friend && (friend.state === 'renew' || friend.state === 'lapsed');
          return h('div', { class: 'list-row' },
            avatar(r.name, r.me ? 'me sm' : 'friend sm'),
            h('span', { dir: 'auto' }, r.me ? 'You' : r.name, h('small', { class: 'muted' }, ` · ${r.hexes == null ? 'still walking' : hexWord(Number(r.hexes))}`)),
            // Walking together never renews a friendship: it only reminds you, and you both still choose.
            due ? h('span', { class: 'renew-line' }, kit.renewal(friend, () => renderCircleSummary({ ...cw, logged: Promise.resolve() }, walk))) : null,
            r.me ? null : h('button', {
              class: 'chip', 'aria-pressed': String(!!r.kudos_from_me),
              onclick: async () => {
                try {
                  await call('circle_kudos_toggle', { session: cw.session, target: r.user_id, give: !r.kudos_from_me });
                  r.kudos_from_me = !r.kudos_from_me;
                  draw();
                } catch (err) {
                  fail(err);
                }
              },
            }, r.kudos_from_me ? '👏 Sent' : '👏 Kudos'));
        })),
        bookBlock(c, cw.session)));
    };
    draw();
  }

  /** "Same time next week?" until it's booked. */
  function bookBlock(c, session) {
    const booked = c.next && c.next.id !== session && c.next.starts > Date.now();
    const others = c.members.filter((m) => !m.me).map((m) => m.name);
    if (booked) {
      return h('div', { class: 'note-row' }, h('span', { class: 'dot friend' }),
        h('span', {}, `✓ Booked for ${fmtWhen(c.next.starts)}${others.length ? ` · ${core.nameList(others)} will see it` : ''}`));
    }
    const box = h('div', { class: 'book-row' },
      h('div', {}, h('b', {}, 'Same time next week?'), h('small', { dir: 'auto' }, `${core.circleSchedule(c.weekday, c.at_time)} · ${place(c)}`)),
      h('button', {
        class: 'btn sm',
        onclick: async () => {
          try {
            await call('book_next', { circle: c.id });
            await loadCircles();
            box.replaceWith(bookBlock(byId(c.id) || c, session));
          } catch (err) {
            fail(err);
          }
        },
      }, 'Book it'));
    return box;
  }

  // ---------- the banner: a walk coming up, or your solo walk ----------

  let bannerTarget = null;

  function updateBanner() {
    const el = $('circleBanner');
    if (!el) return;
    const hiddenFor = loadJSON(BANNER_HIDDEN_KEY, {});
    const now = Date.now();
    bannerTarget = null;
    if (kit.profile && !live) {
      const c = circles.find((x) => x.next && rsvpOf(x) !== 'out' && !hiddenFor[x.next.id]
        && x.next.starts - now <= 2 * REMIND_BEFORE_MS && now <= x.next.starts + core.CHECK_IN_AFTER_MS);
      if (c) {
        const others = core.whoIsIn(c.next.people, me());
        bannerTarget = { kind: 'circle', c };
        $('circleBannerTitle').textContent = `${c.name} · walk ${core.walkWhen(c.next.starts) || fmtTime(c.next.starts)}`;
        $('circleBannerSub').textContent = others.length ? `${core.nameList(others)} ${isAre(others.length)} in · ${place(c)}` : `Meet at ${place(c)}`;
        $('btnCircleBanner').textContent = core.checkInOpen(c.next.starts) && !checkedIn(c) ? 'Check in' : 'Open';
      }
    }
    const solo = loadJSON(SOLO_KEY, null);
    if (!bannerTarget && solo && Math.abs(now - solo.at) <= REMIND_BEFORE_MS && !hiddenFor[`solo${solo.at}`]) {
      bannerTarget = { kind: 'solo', solo };
      $('circleBannerTitle').textContent = 'Your solo walk';
      $('circleBannerSub').textContent = `${solo.district || 'Your neighbourhood'} could use a walk`;
      $('btnCircleBanner').textContent = 'Start';
    }
    if (solo && now - solo.at > REMIND_BEFORE_MS) saveJSON(SOLO_KEY, null);
    el.hidden = !bannerTarget;
    // Keep the map buttons clear of it, as for landmark alerts.
    document.body.classList.toggle('circle-banner-on', !!bannerTarget);
  }

  $('btnCircleBanner').addEventListener('click', () => {
    const t = bannerTarget;
    if (!t) return;
    if (t.kind === 'solo') {
      saveJSON(SOLO_KEY, null);
      updateBanner();
      S.startWalk();
      return;
    }
    if (core.checkInOpen(t.c.next.starts)) showMeetup(t.c.id);
    else show(() => renderHome(t.c.id));
  });
  $('btnCircleBannerClose').addEventListener('click', () => {
    const t = bannerTarget;
    if (!t) return;
    const hidden = loadJSON(BANNER_HIDDEN_KEY, {});
    hidden[t.kind === 'solo' ? `solo${t.solo.at}` : t.c.next.id] = Date.now();
    // Forget hidden banners after a week.
    for (const [k, at] of Object.entries(hidden)) if (Date.now() - at > 7 * 86400000) delete hidden[k];
    saveJSON(BANNER_HIDDEN_KEY, hidden);
    updateBanner();
  });

  // ---------- reminders an hour before (Android app) ----------

  async function askNotifications() {
    if (!LN || loadJSON(NOTIFY_ASKED_KEY, false)) return;
    saveJSON(NOTIFY_ASKED_KEY, true);
    try {
      const p = await LN.requestPermissions();
      if (p.display === 'granted') scheduleReminders();
      else toast('Allow notifications for Scoop in Android settings to get circle reminders', 4000);
    } catch (err) {
      // No reminders, the banner still shows.
    }
  }

  async function scheduleReminders() {
    if (!LN) return;
    try {
      const perm = await LN.checkPermissions();
      if (perm.display !== 'granted') return;
      const { notifications } = await LN.getPending();
      const ours = notifications.filter((n) => n.extra && n.extra.kind === 'circle');
      if (ours.length) await LN.cancel({ notifications: ours.map((n) => ({ id: n.id })) });
      const list = [];
      const now = Date.now();
      for (const c of circles) {
        const n = c.next;
        if (!n || rsvpOf(c) === 'out' || n.starts - REMIND_BEFORE_MS <= now) continue;
        const others = core.whoIsIn(n.people, me());
        list.push({
          id: REMIND_ID + (n.id % 900000),
          title: `${c.name} · walk in 1 hour`,
          body: others.length ? `${core.nameList(others)} ${isAre(others.length)} in. Meet at ${place(c)}.` : `Meet at ${place(c)}.`,
          schedule: { at: new Date(n.starts - REMIND_BEFORE_MS), allowWhileIdle: true },
          actionTypeId: 'circle-walk',
          extra: { kind: 'circle', circle: c.id, session: n.id },
        });
      }
      for (const g of guestWalks) {
        if (!g.approved || g.starts - REMIND_BEFORE_MS <= now) continue;
        list.push({
          id: REMIND_ID + (g.session % 900000),
          title: `${g.circle_name} · walk in 1 hour`,
          body: `You're their guest. Meet at ${place(g)}.`,
          schedule: { at: new Date(g.starts - REMIND_BEFORE_MS), allowWhileIdle: true },
          extra: { kind: 'circle', session: g.session },
        });
      }
      if (list.length) await LN.schedule({ notifications: list });
    } catch (err) {
      // Reminders are a nicety: the banner still shows in the app.
    }
  }

  if (LN) {
    LN.registerActionTypes({
      types: [{ id: 'circle-walk', actions: [{ id: 'omw', title: "I'm on my way" }, { id: 'out', title: "Can't make it", destructive: true }] }],
    }).catch(() => {});
    LN.addListener('localNotificationActionPerformed', async (e) => {
      const x = (e.notification && e.notification.extra) || {};
      if (x.kind === 'solo') {
        saveJSON(SOLO_KEY, null);
        updateBanner();
        if (!S.walking()) S.startWalk();
        return;
      }
      if (x.kind !== 'circle') return;
      await signedIn;
      await loadCircles();
      const c = byId(x.circle);
      if (!c) return;
      if (e.actionId === 'omw') {
        if (await rsvp(c, 'omw')) toast(`Told ${c.name} you're on your way`);
        show(() => renderHome(c.id));
      } else if (e.actionId === 'out') {
        if (await rsvp(c, 'out')) show(() => renderCant(c.id));
      } else {
        show(() => renderHome(c.id));
      }
    }).catch(() => {});
  }

  // ---------- in Me ----------

  function renderMeRow() {
    const box = $('meCircles');
    if (!box) return;
    if (!kit.profile) return fill(box);
    fill(box, h('div', { class: 'list-card' },
      circles.map((c) => h('button', { class: 'list-row', onclick: () => show(() => renderHome(c.id)) },
        h('span', { dir: 'auto' }, `🤝 ${c.name}`),
        h('span', { class: 'row-val' }, c.next ? fmtWhen(c.next.starts) : 'no walk booked'),
        h('span', { class: 'chev' }, '›'))),
      guestWalks.filter((g) => g.approved).map((g) => h('div', { class: 'list-row' },
        h('span', { dir: 'auto' }, `🤝 ${g.circle_name} · guest`),
        h('span', { class: 'row-val' }, fmtWhen(g.starts)))),
      h('button', { class: 'list-row', onclick: openIntro },
        h('span', {}, circles.length ? 'Walk with more people' : 'Start or join a circle'),
        h('span', { class: 'chev' }, '›'))));
  }
  document.addEventListener('scoop:me-open', () => {
    renderMeRow();
    loadCircles();
  });

  // ---------- invite links: …/scoop/?circle=CODE ----------

  const fromUrl = new URLSearchParams(location.search).get('circle');
  if (fromUrl) {
    const code = core.parseCircleInvite(fromUrl);
    if (code) saveJSON(INVITE_KEY, code);
    const q = new URLSearchParams(location.search);
    q.delete('circle');
    history.replaceState(null, '', location.pathname + (q.toString() ? `?${q}` : ''));
  }

  async function acceptInvite() {
    const code = loadJSON(INVITE_KEY, null);
    if (!code) return;
    if (!kit.profile) {
      toast('Sign in to join the circle you were invited to', 4000);
      kit.openSignIn();
      return;
    }
    saveJSON(INVITE_KEY, null);
    try {
      const [r] = await call('join_circle', { code });
      kit.forgetFirsts();
      await loadCircles();
      askNotifications();
      toast(`You joined ${r.name}`, 4000);
      show(() => renderHome(Number(r.id)));
    } catch (err) {
      fail(err);
    }
  }

  // ---------- boot ----------

  let markSignedIn;
  let signedIn = new Promise((r) => { markSignedIn = r; });
  document.addEventListener('scoop:profile', (e) => {
    if (e.detail.profile) {
      markSignedIn();
      loadCircles().then(acceptInvite);
    } else {
      signedIn = new Promise((r) => { markSignedIn = r; });
      leaveLive();
      loadCircles().then(acceptInvite);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && kit.profile) loadCircles();
  });
  setInterval(() => {
    if (!document.hidden && kit.profile) loadCircles();
    else updateBanner();
  }, REFRESH_MS);
  if (kit.profile) loadCircles();

  window.scoopCircles = { openIntro, reload: loadCircles, get circles() { return circles; } };
})();
