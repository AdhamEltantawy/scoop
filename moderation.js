/**
 * Reporting and blocking.
 *
 * Report a landmark you found, or a person you know through Scoop (a friend,
 * a request, someone in your circle or on a walk with you). Block someone so
 * neither of you sees the other's landmarks, friendships end, and you don't
 * end up in a circle together. Nobody is told they were reported or blocked.
 * Reports are reviewed by hand (see supabase/migrations/20261121000000_moderation.sql).
 *
 * Built on window.scoopKit from social.js; adds kit.mod for social.js and circles.js.
 */
(() => {
  'use strict';

  const S = window.scoop;
  const kit = window.scoopKit;
  if (!S || !kit) return;
  const { sb, check, fail, h, fill } = kit;
  const { toast } = S;
  const $ = (id) => document.getElementById(id);

  const LANDMARK_REASONS = [
    ['offensive', 'Offensive or hateful'],
    ['spam', 'Spam or an ad'],
    ['private', "Someone's private information"],
    ['other', 'Something else'],
  ];
  const PERSON_REASONS = [
    ['unsafe', 'Made me feel unsafe'],
    ['harassment', 'Harassing me'],
    ['name', 'Offensive name'],
    ['spam', 'Spam'],
    ['other', 'Something else'],
  ];
  const NOTE_MAX = 300;

  const body = () => $('modBody');

  /** Opens the sheet; `back` returns to wherever you came from (else it just closes). */
  function open(back) {
    S.openSheet('modSheet');
    return () => (back ? back() : S.closeSheet());
  }

  const head = (title, done) => h('div', { class: 'sheet-head' },
    h('span', { class: 'sheet-title', dir: 'auto' }, title),
    h('button', { class: 'icon-btn sm', 'aria-label': 'Back', onclick: done }, '✕'));

  /**
   * The report form: a reason, an optional note, and Send.
   * `send(reason, note)` resolves true for a new report, false if you'd reported it already.
   */
  function reportForm({ title, intro, reasons, send, done, after, extra }) {
    let reason = null;
    let busy = false;
    const note = h('textarea', {
      class: 'input', maxlength: String(NOTE_MAX), rows: '3', dir: 'auto',
      placeholder: 'Anything that helps us understand (optional)', 'aria-label': 'Note',
    });
    const sendBtn = h('button', { class: 'btn', disabled: true }, 'Send report');
    const rows = reasons.map(([v, label]) => h('button', {
      type: 'button', class: 'list-row choice', role: 'radio', 'aria-checked': 'false',
      onclick: () => {
        reason = v;
        for (const r of rows) r.setAttribute('aria-checked', String(r === rowFor(v)));
        sendBtn.disabled = false;
      },
    }, h('span', {}, label), h('span', { class: 'tick', 'aria-hidden': 'true' })));
    const rowFor = (v) => rows[reasons.findIndex(([x]) => x === v)];
    sendBtn.addEventListener('click', async () => {
      if (!reason || busy) return;
      busy = true;
      sendBtn.disabled = true;
      try {
        const fresh = await send(reason, note.value.trim().slice(0, NOTE_MAX) || null);
        fill(body(), h('div', { class: 'stack' },
          head('Thanks', done),
          h('div', { class: 'panel tint sm' },
            h('span', { class: 'card-title' }, fresh ? 'We got your report' : 'You reported this already'),
            h('span', { class: 'body' }, 'We read every report. When three people report the same thing, it\'s hidden until we\'ve looked at it. Nobody is told who reported them.')),
          after || null,
          h('button', { class: 'btn ghost', onclick: done }, 'Done')));
      } catch (err) {
        fail(err);
        busy = false;
        sendBtn.disabled = false;
      }
    });
    fill(body(), h('div', { class: 'stack' },
      head(title, done),
      intro ? h('span', { class: 'body' }, intro) : null,
      h('div', { class: 'list-card', role: 'radiogroup', 'aria-label': 'Reason' }, rows),
      note,
      sendBtn,
      extra || null,
      h('button', { class: 'btn ghost', onclick: done }, 'Cancel')));
  }

  // ---------- landmarks ----------

  /**
   * Report a landmark you found, or stop seeing landmarks from whoever left it.
   * `changed()` runs after a block, so the map can drop their landmarks.
   */
  function landmark(l, { back, changed } = {}) {
    const done = open(back);
    const blockBtn = () => h('button', {
      class: 'btn outline danger',
      onclick: async () => {
        const ok = await S.confirmDialog({
          title: 'Block whoever left this?',
          body: "You won't see their landmarks and they won't see yours. If you're friends, that ends too. You still won't know who it was, and they aren't told.",
          confirm: 'Block',
        });
        if (ok !== 'confirm') return;
        try {
          check(await sb.rpc('block_author', { landmark: l.id }));
          toast('Blocked · their landmarks are gone from your map');
          if (changed) changed();
          S.closeSheet();
        } catch (err) {
          fail(err);
        }
      },
    }, 'Block whoever left it');

    reportForm({
      title: 'Report this landmark',
      intro: `"${l.title}" · What's wrong with it?`,
      reasons: LANDMARK_REASONS,
      send: async (reason, note) => check(await sb.rpc('report_landmark', { landmark: l.id, reason, note })),
      done,
      after: h('div', { class: 'stack tight' },
        h('span', { class: 'sublabel' }, 'Rather not see anything else they leave?'), blockBtn()),
      // Blocking is offered up front too, for when there's nothing to report.
      extra: h('div', { class: 'stack tight mod-or' },
        h('span', { class: 'sublabel' }, 'Or just stop seeing landmarks from whoever left it'), blockBtn()),
    });
  }

  // ---------- people ----------

  /**
   * What you can do about someone: `p` is {id, name}.
   *   remove   optional [label, fn] shown first (e.g. "Remove friend")
   *   changed  runs after a block, to refresh whatever listed them
   *   note     a line under their name (e.g. why blocking needs leaving a circle first)
   */
  function person(p, { back, changed, remove, note } = {}) {
    const done = open(back);
    const name = p.name || 'this person';
    const menu = () => fill(body(), h('div', { class: 'stack' },
      head(name, done),
      h('div', { class: 'list-card' },
        remove ? h('button', { class: 'list-row', onclick: () => { done(); remove[1](); } },
          h('span', {}, remove[0]), h('span', { class: 'chev' }, '›')) : null,
        h('button', { class: 'list-row', onclick: report },
          h('span', { dir: 'auto' }, `Report ${name}`), h('span', { class: 'chev' }, '›')),
        h('button', { class: 'list-row danger', onclick: block },
          h('span', { dir: 'auto' }, `Block ${name}`))),
      note ? h('span', { class: 'fine' }, note) : null,
      h('span', { class: 'fine' }, "They aren't told if you report or block them."),
      h('button', { class: 'btn ghost', onclick: done }, 'Cancel')));

    function report() {
      reportForm({
        title: `Report ${name}`,
        intro: 'What happened?',
        reasons: PERSON_REASONS,
        send: async (reason, text) => check(await sb.rpc('report_person', { person: p.id, reason, note: text })),
        done,
        after: h('div', { class: 'stack tight' },
          h('span', { class: 'sublabel' }, `Don't want to walk with ${name} again?`),
          h('button', { class: 'btn outline danger', onclick: block }, `Block ${name}`)),
      });
    }

    async function block() {
      const ok = await S.confirmDialog({
        title: `Block ${name}?`,
        body: `If you're friends, that ends, and ${name} can't add you again. Neither of you sees the other's landmarks, `
          + "or can join a circle the other is in. In circles you started, they're removed. They aren't told.",
        confirm: 'Block',
      });
      if (ok !== 'confirm') return;
      try {
        check(await sb.rpc('block_person', { person: p.id }));
        toast(`Blocked ${name}`);
        if (changed) await changed();
        done();
      } catch (err) {
        fail(err);
      }
    }

    menu();
  }

  /** "Blocked people" in Settings. */
  async function blocked({ back } = {}) {
    const done = open(back);
    fill(body(), h('div', { class: 'stack' }, head('Blocked people', done), h('span', { class: 'fine' }, 'Loading…')));
    let rows = [];
    try {
      rows = check(await sb.rpc('my_blocks'));
    } catch (err) {
      fail(err);
    }
    const draw = () => fill(body(), h('div', { class: 'stack' },
      head('Blocked people', done),
      rows.length
        ? h('div', { class: 'list-card' }, rows.map((r) => h('div', { class: 'list-row' },
          h('span', { dir: 'auto' }, r.from_landmark ? 'Someone who left a landmark' : r.name),
          h('button', {
            class: 'link',
            onclick: async () => {
              try {
                check(await sb.rpc('unblock', { block: r.id }));
                rows = rows.filter((x) => x !== r);
                toast('Unblocked');
                draw();
              } catch (err) {
                fail(err);
              }
            },
          }, 'Unblock'))))
        : h('span', { class: 'body' }, "You haven't blocked anyone."),
      h('span', { class: 'fine' }, 'Unblocking doesn\'t bring back friendships or circles: start again with an invite.'),
      h('button', { class: 'btn ghost', onclick: done }, 'Done')));
    draw();
  }

  /** The small "⋯" button that opens `person()` from a row. */
  const moreBtn = (p, opts) => h('button', {
    class: 'icon-btn sm more', 'aria-label': `More for ${p.name || 'this person'}`,
    onclick: (e) => { e.stopPropagation(); person(p, opts); },
  }, '⋯');

  kit.mod = { landmark, person, blocked, moreBtn };
})();
