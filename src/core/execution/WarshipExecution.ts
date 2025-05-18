import { consolex } from "../Consolex";
import {
  Execution,
  Game,
  isUnit,
  OwnerComp,
  Unit,
  UnitParams,
  UnitType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import { PathFindResultType } from "../pathfinding/AStar";
import { PathFinder } from "../pathfinding/PathFinding";
import { PseudoRandom } from "../PseudoRandom";
import { ShellExecution } from "./ShellExecution";

export class WarshipExecution implements Execution {
  private random: PseudoRandom;

  private warship: Unit;
  private mg: Game;

  private pathfinder: PathFinder;

  private lastShellAttack = 0;
  private alreadySentShell = new Set<Unit>();

  constructor(
    private input: (UnitParams<UnitType.Warship> & OwnerComp) | Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.pathfinder = PathFinder.Mini(mg, 5000);
    this.random = new PseudoRandom(mg.ticks());
    if (isUnit(this.input)) {
      this.warship = this.input;
    } else {
      const spawn = this.input.owner.canBuild(
        UnitType.Warship,
        this.input.patrolTile,
      );
      if (spawn === false) {
        console.warn(
          `Failed to spawn warship for ${this.input.owner.name()} at ${this.input.patrolTile}`,
        );
        return;
      }
      this.warship = this.input.owner.buildUnit(
        UnitType.Warship,
        spawn,
        this.input,
      );
      return;
    }
  }

  tick(ticks: number): void {
    if (!this.warship.isActive()) {
      return;
    }
    if (
      this.warship.targetUnit() !== undefined &&
      !this.warship.targetUnit()!.isActive()
    ) {
      this.warship.setTargetUnit(undefined);
    }
    const hasPort = this.warship.owner().units(UnitType.Port).length > 0;
    const warship = this.warship;
    const ships = this.mg
      .nearbyUnits(
        this.warship.tile(),
        this.mg.config().warshipTargettingRange(),
        [UnitType.TransportShip, UnitType.Warship, UnitType.TradeShip],
      )
      .filter(
        ({ unit }) =>
          unit.owner() !== warship.owner() &&
          unit !== warship &&
          !unit.owner().isFriendly(warship.owner()) &&
          !this.alreadySentShell.has(unit) &&
          (unit.type() !== UnitType.TradeShip ||
            (hasPort &&
              unit.targetUnit()?.owner() !== this.warship.owner() &&
              !unit.targetUnit()?.owner().isFriendly(this.warship.owner()) &&
              unit.isSafeFromPirates() !== true)),
      );

    const target = ships.sort((a, b) => {
      const { unit: unitA, distSquared: distA } = a;
      const { unit: unitB, distSquared: distB } = b;

      // Prioritize Warships
      if (
        unitA.type() === UnitType.Warship &&
        unitB.type() !== UnitType.Warship
      )
        return -1;
      if (
        unitA.type() !== UnitType.Warship &&
        unitB.type() === UnitType.Warship
      )
        return 1;

      // Then favor Transport Ships over Trade Ships
      if (
        unitA.type() === UnitType.TransportShip &&
        unitB.type() !== UnitType.TransportShip
      )
        return -1;
      if (
        unitA.type() !== UnitType.TransportShip &&
        unitB.type() === UnitType.TransportShip
      )
        return 1;

      // If both are the same type, sort by distance (lower `distSquared` means closer)
      return distA - distB;
    })[0]?.unit;
    this.warship.setTargetUnit(target);

    const moveTarget = this.warship.targetTile();
    if (moveTarget) {
      this.goToMoveTarget(moveTarget);
      // If we have a "move target" then we cannot target trade ships as it
      // requires moving.
      if (this.warship.targetUnit()?.type() === UnitType.TradeShip) {
        this.warship.setTargetUnit(undefined);
      }
    } else if (this.warship.targetUnit()?.type() !== UnitType.TradeShip) {
      this.patrol();
    }

    if (
      this.warship.targetUnit() === undefined ||
      !this.warship.targetUnit()!.isActive() ||
      this.warship.targetUnit()!.owner() === this.warship.owner() ||
      this.warship.targetUnit()!.isSafeFromPirates() === true
    ) {
      // In case another warship captured or destroyed target, or the target escaped into safe waters
      this.warship.setTargetUnit(undefined);
      return;
    }

    // If we have a move target we do not want to go after trading ships
    if (this.warship.targetUnit() === undefined) {
      return;
    }

    if (this.warship.targetUnit()!.type() !== UnitType.TradeShip) {
      this.shoot();
      return;
    }

    for (let i = 0; i < 2; i++) {
      // target is trade ship so capture it.
      const result = this.pathfinder.nextTile(
        this.warship.tile(),
        this.warship.targetUnit()!.tile(),
        5,
      );
      switch (result.type) {
        case PathFindResultType.Completed:
          this.warship.owner().captureUnit(this.warship.targetUnit()!);
          this.warship.setTargetUnit(undefined);
          this.warship.move(this.warship.tile());
          return;
        case PathFindResultType.NextTile:
          this.warship.move(result.tile);
          break;
        case PathFindResultType.Pending:
          this.warship.move(this.warship.tile());
          break;
        case PathFindResultType.PathNotFound:
          consolex.log(`path not found to target`);
          break;
      }
    }
  }

  // Only for warships with "moveTarget" set
  goToMoveTarget(target: TileRef) {
    if (this.warship === null || this.pathfinder === null) {
      throw new Error("Warship not initialized");
    }
    // Patrol unless we are hunting down a tradeship
    const result = this.pathfinder.nextTile(this.warship.tile(), target);
    switch (result.type) {
      case PathFindResultType.Completed:
        this.warship.setTargetTile(undefined);
        this.warship.touch();
        return;
      case PathFindResultType.NextTile:
        this.warship.move(result.tile);
        break;
      case PathFindResultType.Pending:
        this.warship.touch();
        break;
      case PathFindResultType.PathNotFound:
        consolex.log(`path not found to target`);
        break;
    }
  }

  private shoot() {
    const shellAttackRate = this.mg.config().warshipShellAttackRate();
    if (this.mg.ticks() - this.lastShellAttack > shellAttackRate) {
      this.lastShellAttack = this.mg.ticks();
      this.mg.addExecution(
        new ShellExecution(
          this.warship.tile(),
          this.warship.owner(),
          this.warship,
          this.warship.targetUnit()!,
        ),
      );
      if (!this.warship.targetUnit()!.hasHealth()) {
        // Don't send multiple shells to target that can be oneshotted
        this.alreadySentShell.add(this.warship.targetUnit()!);
        this.warship.setTargetUnit(undefined);
        return;
      }
    }
  }

  private patrol() {
    if (this.warship.targetTile() === undefined) {
      this.warship.setTargetTile(this.randomTile());
      if (this.warship.targetTile() === undefined) {
        return;
      }
    }
    if (this.warship.targetUnit()?.type() !== UnitType.TradeShip) {
      // Patrol unless we are hunting down a tradeship
      const result = this.pathfinder.nextTile(
        this.warship.tile(),
        this.warship.targetTile()!,
      );
      switch (result.type) {
        case PathFindResultType.Completed:
          this.warship.setTargetTile(undefined);
          this.warship.touch();
          break;
        case PathFindResultType.NextTile:
          this.warship.move(result.tile);
          break;
        case PathFindResultType.Pending:
          this.warship.touch();
          return;
        case PathFindResultType.PathNotFound:
          consolex.log(`path not found to patrol tile`);
          this.warship.setTargetTile(undefined);
          break;
      }
    }
  }

  isActive(): boolean {
    return this.warship?.isActive();
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  randomTile(allowShoreline: boolean = false): TileRef | undefined {
    let warshipPatrolRange = this.mg.config().warshipPatrolRange();
    const maxAttemptBeforeExpand: number = 500;
    let attempts: number = 0;
    let expandCount: number = 0;
    while (expandCount < 3) {
      const x =
        this.mg.x(this.warship.patrolTile()!) +
        this.random.nextInt(-warshipPatrolRange / 2, warshipPatrolRange / 2);
      const y =
        this.mg.y(this.warship.patrolTile()!) +
        this.random.nextInt(-warshipPatrolRange / 2, warshipPatrolRange / 2);
      if (!this.mg.isValidCoord(x, y)) {
        continue;
      }
      const tile = this.mg.ref(x, y);
      if (
        !this.mg.isOcean(tile) ||
        (!allowShoreline && this.mg.isShoreline(tile))
      ) {
        attempts++;
        if (attempts === maxAttemptBeforeExpand) {
          expandCount++;
          attempts = 0;
          warshipPatrolRange =
            warshipPatrolRange + Math.floor(warshipPatrolRange / 2);
        }
        continue;
      }
      return tile;
    }
    console.warn(
      `Failed to find random tile for warship for ${this.warship.owner().name()}`,
    );
    if (!allowShoreline) {
      // If we failed to find a tile on the ocean, try again but allow shoreline
      return this.randomTile(true);
    }
    return undefined;
  }
}
