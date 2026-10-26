import type { RoundSummary, ResultStats } from './gameplay/competition.ts';

interface StandingsPort {
  summary(): RoundSummary | null;
  records(): Readonly<Record<string, readonly number[]>>;
  subscribe(change: () => void): () => void;
  opening(): void;
}
export function formatCompetitionValue(value: number | null, unit = ''): string {
  return value === null
    ? '—'
    : `${Number.isFinite(value) ? Number(value.toFixed(1)).toLocaleString() : '—'}${unit}`;
}
const RECORD_LABELS: Readonly<Record<string, string>> = {
  round_points: 'Round points',
  top_speed_kmh: 'Top speed · km/h',
  distance_m: 'Distance · m',
  survival_s: 'Survival · s',
  burn_s: 'Longest burn · s',
  paint_accuracy: 'Paint accuracy · %',
  mechanic_jobs: 'Mechanic jobs',
  mechanic_repairs: 'Repairs restored',
  mechanic_fuel: 'Fuel delivered',
  mechanic_precision: 'Mechanic precision · %',
};
export function mountCompetitionPanel(port: StandingsPort) {
  const dialog = document.createElement('dialog');
  dialog.className = 'utility-dialog competition-dialog';
  dialog.setAttribute('aria-labelledby', 'standingsTitle');
  const header = document.createElement('header'),
    title = document.createElement('h2'),
    close = document.createElement('button');
  title.id = 'standingsTitle';
  title.textContent = 'Crew standings';
  close.className = 'btn small';
  close.textContent = 'Close';
  close.onclick = () => dialog.close();
  header.append(title, close);
  const tabs = document.createElement('div');
  tabs.className = 'utility-actions';
  const round = document.createElement('button'),
    records = document.createElement('button');
  round.className = records.className = 'btn small';
  round.textContent = 'Round & championships';
  records.textContent = 'Anonymous high scores';
  tabs.append(round, records);
  const body = document.createElement('div');
  body.className = 'competition-body';
  body.tabIndex = 0;
  dialog.append(header, tabs, body);
  document.body.append(dialog);
  let anonymous = false;
  function paragraph(text: string): void {
    const p = document.createElement('p');
    p.textContent = text;
    body.append(p);
  }
  function heading(text: string): void {
    const h = document.createElement('h3');
    h.textContent = text;
    body.append(h);
  }
  function table(labels: string[], rows: (string | number)[][]): void {
    const wrap = document.createElement('div');
    wrap.className = 'competition-table';
    const table = document.createElement('table'),
      head = document.createElement('thead'),
      tr = document.createElement('tr');
    for (const label of labels) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      tr.append(th);
    }
    head.append(tr);
    table.append(head);
    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const text of row) {
        const td = document.createElement('td');
        td.textContent = String(text);
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    wrap.append(table);
    body.append(wrap);
  }
  function facts(stats: ResultStats): string[] {
    const n = formatCompetitionValue;
    return [
      n(stats.points),
      `${stats.hits}/${stats.shots}`,
      n(stats.accuracy, '%'),
      n(stats.topSpeedKmh),
      n(stats.distanceM),
      n(stats.survivalS),
      n(stats.longestBurnS),
      n(stats.jobs),
      n(stats.repairs),
      n(stats.fuel),
      n(stats.precision, '%'),
    ];
  }
  function render(): void {
    body.replaceChildren();
    round.setAttribute('aria-pressed', String(!anonymous));
    records.setAttribute('aria-pressed', String(anonymous));
    if (anonymous) {
      paragraph(
        'Completed results across rounds on this device. Values only: no player, team, game, room, instance or date is stored in these records. Online results follow your Zirbel reporting preference.',
      );
      const all = port.records();
      let count = 0;
      for (const [key, label] of Object.entries(RECORD_LABELS)) {
        const scores = all[key];
        if (!scores?.length) continue;
        count++;
        heading(label);
        table(
          ['Rank', 'Score'],
          scores.slice(0, 10).map((value, index) => [index + 1, formatCompetitionValue(value)]),
        );
      }
      if (!count)
        paragraph(
          'Finish a round to set the first records. Paint accuracy needs 10 shots; mechanic precision needs 5 measured actions.',
        );
      return;
    }
    const summary = port.summary();
    if (!summary) {
      paragraph(
        'Finish a round to see the crew report. Drive, fire paint, repair systems and keep the car alive: each role has its own measures.',
      );
      return;
    }
    paragraph(
      `Round ${summary.round} · ${formatCompetitionValue(summary.duration, ' s')} · Names in this report stay within this game.`,
    );
    heading('Team round results');
    const labels = [
      'Crew',
      'Points',
      'Hits/shots',
      'Accuracy',
      'Top km/h',
      'Distance m',
      'Survived s',
      'Burn s',
      'Jobs',
      'Repairs',
      'Fuel',
      'Precision',
    ];
    table(
      labels,
      [...summary.teams].sort((a, b) => b.points - a.points).map((team) => [team.name, ...facts(team)]),
    );
    heading('Mechanics championship');
    paragraph(
      'A separate crew title: completed jobs, system repairs and fuel delivered earn mechanic points. Measured action precision is shown separately.',
    );
    table(
      ['Crew', 'Jobs', 'Repairs', 'Fuel', 'Precision', 'Actions', 'Round pts', 'Championship pts'],
      [...summary.mechanics]
        .sort((a, b) => b.totalPoints - a.totalPoints)
        .map((m) => [
          m.name,
          m.jobs,
          formatCompetitionValue(m.repairs),
          formatCompetitionValue(m.fuel),
          formatCompetitionValue(m.precision, '%'),
          m.precisionAttempts,
          formatCompetitionValue(m.points),
          formatCompetitionValue(m.totalPoints),
        ]),
    );
    heading('Constructors championship');
    paragraph(
      'Car builds compete across rounds in this match. Starting a new match resets the championship.',
    );
    table(
      ['Constructor', 'Points', 'Wins', 'Rounds'],
      [...summary.constructors]
        .sort((a, b) => b.points - a.points)
        .map((c) => [c.name, formatCompetitionValue(c.points), c.wins, c.rounds]),
    );
    heading('Player contributions');
    if (summary.players.length)
      table(
        ['Player', 'Crew', ...labels.slice(2)],
        summary.players.map((p) => [
          p.name,
          summary.teams.find((t) => t.team === p.team)?.name ?? '—',
          ...facts(p).slice(1),
        ]),
      );
    else paragraph('Bots filled the crew seats this round.');
    paragraph(
      '— means no measured result. Precision measures supported discrete mechanic actions; remote precision is unavailable. Team points are shared; individual rows show attributable actions. Bot actions contribute to team totals.',
    );
  }
  round.onclick = () => {
    anonymous = false;
    render();
  };
  records.onclick = () => {
    anonymous = true;
    render();
  };
  for (const event of ['keydown', 'keyup', 'pointerdown', 'pointerup'])
    dialog.addEventListener(event, (e) => e.stopPropagation());
  const unsubscribe = port.subscribe(() => {
    if (dialog.open) render();
    const button = document.getElementById('statsBtn');
    if (button && port.summary()) button.textContent = 'Round results';
  });
  return {
    open() {
      port.opening();
      render();
      if (!dialog.open) dialog.showModal();
    },
    destroy() {
      unsubscribe();
      dialog.remove();
    },
  };
}
