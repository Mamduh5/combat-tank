import type { RosterEntry } from '../../shared/roster.js';
import type { VehicleDefinition } from '../../shared/vehicle-definition.js';
import { VEHICLE_ROSTER } from '../../shared/roster.js';

/**
 * The pre-battle vehicle selector.
 *
 * ## What this is, and what it deliberately is not
 *
 * A content tool, not a garage. The brief is explicit that V8 must not build ownership, unlocks, a tech
 * tree or persistence, and this file is the boundary: it shows every vehicle the roster contains, every
 * time, with no state carried between sessions. What it adds over "just drive the default tank" is the
 * ability to *see the difference and pick it*, which is the whole point of having a roster.
 *
 * ## Why it shows bars rather than numbers
 *
 * The brief asks the selector to communicate meaningful differences and not to expose every raw stat. A
 * card reading `285 mm / 7.5 s / 1600 HP` is a spreadsheet, and a player cannot tell from it which vehicle
 * suits them. Four labelled bars — Protection, Mobility, Firepower, Handling — say the same thing in a form
 * that can be read at a glance and compared across the roster.
 *
 * **The bars are computed from the definition, never authored.** A hand-written "Heavy: Protection 5/5" is
 * a claim about the designer; a computed one is a fact about the data, and the two cannot disagree. This is
 * the single most important property of the file, and it is why {@link rateRoster} is a pure function that
 * can be tested without a DOM.
 *
 * ## Why the opponent is selectable too
 *
 * Because V8 requires battle validation across matchups — medium against medium, light against heavy — and
 * because a question like "does the heavy feel different?" deserves an answer obtainable in one keypress
 * rather than by editing code. It is also the least interesting feature here to get wrong: the opponent is
 * a battle setup parameter, not a game mode.
 */

/**
 * A vehicle's four visible characteristics, each in `[0, 1]` relative to the rest of the roster.
 *
 * Relative rather than absolute on purpose. An absolute scale would need a judgement about what a "10"
 * means; a relative one only has to answer "which of these three is best at this", which is the only
 * question a selector can usefully answer.
 */
export interface VehicleRatings {
  /** Survivability: hit points, and how much work it is to get through the front. */
  readonly protection: number;
  /** How fast it goes and how readily it changes direction. */
  readonly mobility: number;
  /** Damage per penetration, how easily it penetrates, and how fast it can repeat. */
  readonly firepower: number;
  /** Acceleration, turret agility, and how decisively it stops. */
  readonly handling: number;
}
/**
 * Raw, unit-free scores for one vehicle.
 *
 * Kept separate from the normalised result so the *shape* of each characteristic is stated once, in one
 * place, and can be argued about without touching the UI. The weights below are the whole design of the
 * selector, so they are written as named arithmetic rather than folded into a single opaque expression.
 */
function rawScores(vehicle: VehicleDefinition): VehicleRatings {
  const front = vehicle.armor.find((plate) => plate.region === 'hull-front');
  // Effective frontal armour in millimetres: the same `nominal / cos(slope)` the penetration model uses.
  // Measured rather than taken from `thicknessMm` because a thick vertical plate and a thinner sloped one
  // are not the same protection, and a rating that ignored slope would call the light well armoured.
  const frontalMm =
    front === undefined
      ? 0
      : front.thicknessMm / Math.max(0.05, Math.cos((front.pitchDeg * Math.PI) / 180));

  // Damage per shot is meaningless alone: a light gun fired often and a heavy gun fired rarely land a
  // similar number of points per minute. Dividing by reload time is what makes the number mean something.
  const dps = vehicle.survivability.damagePerPenetration / vehicle.mainGun.reloadSeconds;

  return {
    // Hit points dominate, frontal armour is a modifier — so a vehicle's *shape* survives normalisation. A
    // light can have the best penetration-per-hit in the roster and still rate lowest here, which is right:
    // the selector is describing survivability, not gun statistics.
    protection: vehicle.survivability.hitPoints * (1 + frontalMm / 1000),
    // Top speed plus a share of hull traverse, because "quick" and "changeable direction" are two different
    // things a player cares about and the medium and the light trade them off against each other.
    mobility: vehicle.powertrain.maxSpeedMps + vehicle.traversal.hullTraverseDegPerSec * 0.35,
    // Damage per second, plus penetration as a fraction of the thickest plate in the game. A gun that
    // out-damages everything but cannot defeat the plate in front of it is not a strong gun.
    firepower: dps * (1 + vehicle.mainShell.nominalPenetrationMm / 400),
    // Acceleration, turret agility and braking: the three things that make a vehicle feel responsive
    // rather than merely quick.
    handling:
      (vehicle.powertrain.driveForceN / vehicle.powertrain.massKg) * 2 +
      vehicle.turret.traverseDegPerSec * 0.08 +
      vehicle.powertrain.brakeDecelMps2 * 0.3,
  };
}

/**
 * Rates every roster vehicle on all four characteristics, normalised across the roster.
 *
 * Normalisation is min-max, so the weakest vehicle scores 0 and the strongest 1 on each axis. That is
 * honest about what it is: a comparison between the vehicles on offer, not a judgement about tanks. If the
 * roster later grows to twenty vehicles the weakest will still read 0, which fairly summarises a roster
 * rather than a statement about the vehicle.
 *
 * Pure, and that is why this file is not just a bag of DOM calls: the interesting question — "do the bars
 * actually describe the roster?" — is answerable without a browser.
 */
export function rateRoster(roster: readonly RosterEntry[] = VEHICLE_ROSTER): Map<string, VehicleRatings> {
  const raw = roster.map((entry) => ({ id: entry.vehicle.id, scores: rawScores(entry.vehicle) }));
  const ratings = new Map<string, VehicleRatings>();

  for (const key of ['protection', 'mobility', 'firepower', 'handling'] as const) {
    const values = raw.map((r) => r.scores[key]);
    const min = Math.min(...values);
    const span = Math.max(...values) - min;
    for (const entry of raw) {
      const existing = ratings.get(entry.id) ?? {
        protection: 0,
        mobility: 0,
        firepower: 0,
        handling: 0,
      };
      // Every vehicle identical on an axis is a legitimate state — a roster of one, or two vehicles that
      // genuinely are identical there — and must not divide by zero into NaN bars.
      const scaled = span === 0 ? 0.5 : (entry.scores[key] - min) / span;
      ratings.set(entry.id, { ...existing, [key]: scaled });
    }
  }
  return ratings;
}

/**
 * One-line summary of a rating, in words rather than as bars, for a card's accessible label.
 *
 * A bar drawn as a `<div>` is invisible to a screen reader and unreadable to a player using a high-contrast
 * mode, so every bar carries this as its `aria-label` and the visible bar is `aria-hidden`.
 */
export function ratingSummary(ratings: VehicleRatings): string {
  const percent = (value: number): number => Math.round(value * 100);
  return (
    `Protection ${percent(ratings.protection)} out of 100, mobility ${percent(ratings.mobility)}, ` +
    `firepower ${percent(ratings.firepower)}, handling ${percent(ratings.handling)}`
  );
}

/** What the selector asks for when the player commits to a matchup. */
export interface SelectionChoice {
  readonly playerVehicleId: string;
  readonly opponentVehicleId: string;
}

/**
 * Neutral ratings, used where a vehicle somehow has none.
 *
 * `rateRoster` covers the whole roster, so this is unreachable in practice — it exists because the render
 * path must not be the place a missing entry throws, because a crash here means the player cannot start a
 * battle at all. All fours rather than zeros, so a degenerate card looks "average" rather than "empty".
 */
const EMPTY_RATINGS: VehicleRatings = {
  protection: 0.5,
  mobility: 0.5,
  firepower: 0.5,
  handling: 0.5,
};

/** The four bars, in display order. Named here so the markup and the ratings cannot disagree. */
const RATING_LABELS: readonly { key: keyof VehicleRatings; label: string }[] = [
  { key: 'protection', label: 'Protection' },
  { key: 'mobility', label: 'Mobility' },
  { key: 'firepower', label: 'Firepower' },
  { key: 'handling', label: 'Handling' },
];

/**
 * The selector screen itself: two rows of vehicle cards, previous/next controls, and a deploy button.
 *
 * ## Keyboard and pointer both work, and both are complete
 *
 * The deploy button is a real `<button>` and every card is focusable, so the screen is usable with a pointer,
 * a keyboard, or a screen reader without any of the three being a second-class path. That is not a
 * accessibility afterthought here — a selector that only responds to arrow keys is untestable by the
 * automated gates and unusable for part of the audience.
 *
 * ## It holds no state of its own
 *
 * The selected ids are passed in and reported out through `onDeploy`. Nothing is remembered between
 * sessions, which is the deliberate boundary described at the top of this file: this is a content tool, and
 * a content tool that remembered your last choice would be the first step towards the garage V11 owns.
 */
export class VehicleSelectScreen {
  private readonly root: HTMLElement | null;
  private readonly ratings = rateRoster();
  private readonly onDeploy: (choice: SelectionChoice) => void;
  private playerIndex: number;
  private opponentIndex: number;

  constructor(
    rootId: string,
    initial: SelectionChoice,
    onDeploy: (choice: SelectionChoice) => void,
  ) {
    this.root = document.getElementById(rootId);
    this.onDeploy = onDeploy;
    this.playerIndex = VEHICLE_ROSTER.findIndex((e) => e.vehicle.id === initial.playerVehicleId);
    this.opponentIndex = VEHICLE_ROSTER.findIndex((e) => e.vehicle.id === initial.opponentVehicleId);
    // A caller that passes an unknown id lands on the first vehicle rather than on a blank screen.
    if (this.playerIndex < 0) this.playerIndex = 0;
    if (this.opponentIndex < 0) this.opponentIndex = VEHICLE_ROSTER.length - 1;

    this.root?.addEventListener('keydown', this.onKeyDown);
    // The button is a sibling of the screen rather than a child, so it is looked up by id here. Kept as a
    // separate listener rather than a click handler on `root` so that clicking it does not also bubble into
    // the card row.
    document.getElementById('select-deploy')?.addEventListener('click', this.onDeployClick);
    this.render();
  }

  private readonly onDeployClick = (): void => {
    this.deploy();
  };

  /** The matchup currently shown, whether or not the screen has been dismissed. */
  get choice(): SelectionChoice {
    return {
      playerVehicleId: VEHICLE_ROSTER[this.playerIndex]!.vehicle.id,
      opponentVehicleId: VEHICLE_ROSTER[this.opponentIndex]!.vehicle.id,
    };
  }

  /**
   * Whether the selector is currently on screen.
   *
   * The frame loop polls this to hold the simulation still while the player is choosing. Without it the
   * battle would carry on behind the overlay, the AI would open fire, and the player would return from a
   * menu to a fight that had already been decided for them.
   */
  get isOpen(): boolean {
    return this.root?.classList.contains('show') ?? false;
  }

  /** Re-opens the selector on the current matchup, for the in-battle "change vehicle" key. */
  open(): void {
    this.show();
  }

  /** Shows the screen and puts keyboard focus on it, so the arrow keys work immediately. */
  show(): void {
    this.root?.classList.add('show');
    this.root?.focus();
  }

  /** Hides the screen. Called when a matchup is deployed. */
  hide(): void {
    this.root?.classList.remove('show');
  }

  /**
   * Arrow keys move the selection; Enter deploys.
   *
   * Bound to the screen rather than to the window so it cannot fire while the battle is running. That is the
   * whole reason this is not a global handler: a global arrow-key handler is the kind of thing that quietly
   * steals the mouse look during a fight.
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.root?.classList.contains('show')) {
      return;
    }
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step !== 0) {
      event.preventDefault();
      // Shift moves the opponent row. Otherwise both rows would respond to the same key and the player
      // would have no way to reach the second one.
      const target = event.shiftKey ? 'opponent' : 'player';
      this.move(target, step);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.deploy();
    }
  };

  private move(target: 'player' | 'opponent', step: number): void {
    const wrap = (index: number): number =>
      (index + step + VEHICLE_ROSTER.length) % VEHICLE_ROSTER.length;
    if (target === 'player') {
      this.playerIndex = wrap(this.playerIndex);
    } else {
      this.opponentIndex = wrap(this.opponentIndex);
    }
    this.render();
  }

  private deploy(): void {
    this.hide();
    this.onDeploy(this.choice);
  }
/**
   * Rebuilds the two card rows from the roster.
   *
   * Rebuilt wholesale rather than diffed. There are three vehicles and this screen is shown a handful of
   * times per session; a keyed-update path would be code that exists to be wrong later, and would have to
   * handle the case where the roster itself changes between renders.
   */
  private render(): void {
    if (this.root === null) {
      return;
    }
    for (const row of ['player', 'opponent'] as const) {
      const host = this.root.querySelector(`#${row}-cards`);
      if (host === null) {
        continue;
      }
      const selected = row === 'player' ? this.playerIndex : this.opponentIndex;
      host.replaceChildren(
        ...VEHICLE_ROSTER.map((entry, index) => {
          const ratings = this.ratings.get(entry.vehicle.id);
          const card = document.createElement('button');
          card.type = 'button';
          card.className = index === selected ? 'v-card selected' : 'v-card';
          card.setAttribute('aria-pressed', String(index === selected));

          const name = document.createElement('span');
          name.className = 'v-name';
          name.textContent = entry.vehicle.displayName;

          const role = document.createElement('span');
          role.className = 'v-role';
          role.textContent = entry.role;

          const tagline = document.createElement('span');
          tagline.className = 'v-tagline';
          tagline.textContent = entry.tagline;

          const bars = document.createElement('span');
          bars.className = 'v-bars';
          if (ratings !== undefined) {
            for (const { key, label } of RATING_LABELS) {
              bars.appendChild(this.bar(label, ratings[key]));
            }
          }

          card.append(name, role, tagline, bars);
          // The card's own accessible name. The bars below carry per-axis labels; this one carries the whole
          // shape, so a screen-reader user hears the same comparison a sighted user reads off four bars.
          card.setAttribute('aria-label', `${entry.vehicle.displayName}, ${role.textContent}. ${ratingSummary(ratings ?? EMPTY_RATINGS)}`);
          card.addEventListener('click', () => {
            if (row === 'player') {
              this.playerIndex = index;
            } else {
              this.opponentIndex = index;
            }
            this.render();
          });
          return card;
        }),
      );
    }

    const summary = this.root.querySelector('#select-summary');
    if (summary !== null) {
      const player = VEHICLE_ROSTER[this.playerIndex]!;
      const opponent = VEHICLE_ROSTER[this.opponentIndex]!;
      // Strength *and* weakness, because the pair is the argument. A card that only listed what a vehicle
      // is good at is advertising; one that lists both is a choice, and this line is where the choice is
      // made explicit before the player commits.
      summary.textContent =
        `${player.vehicle.displayName} — ${player.tagline} Strong: ${player.strength} ` +
        `Weak: ${player.weakness} Facing ${opponent.vehicle.displayName}.`;
    }
  }

  /** One labelled bar. The label is screen-reader text; the fill is decorative. */
  private bar(label: string, value: number): HTMLElement {
    const row = document.createElement('span');
    row.className = 'v-bar';
    row.setAttribute('role', 'img');
    row.setAttribute('aria-label', `${label} ${Math.round(value * 100)} out of 100`);

    const text = document.createElement('span');
    text.className = 'v-bar-label';
    text.textContent = label;

    const track = document.createElement('span');
    track.className = 'v-bar-track';
    track.setAttribute('aria-hidden', 'true');

    const fill = document.createElement('span');
    fill.className = 'v-bar-fill';
    // Percentage width rather than a scale transform: it is the one property a high-contrast mode and a
    // screen magnifier both handle without the bar losing its meaning.
    fill.style.width = `${Math.round(value * 100)}%`;
    track.appendChild(fill);

    row.append(text, track);
    return row;
  }
}