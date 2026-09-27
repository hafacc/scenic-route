// A city's trees as columns: 26 bytes a tree rather than an object and a string reference each.

import type { Tree } from "./socrata";

// Genus 0 is "", the unknown genus.
export interface TreeTable {
  length: number;
  lat: Float64Array;
  lng: Float64Array;
  // Float64: SF's and the East Bay's diameters are fractional inches.
  dbhInches: Float64Array;
  genus: Uint16Array; // into `genera`
  genera: string[];
}

export class TreeTableBuilder {
  private table: TreeTable = {
    length: 0,
    lat: new Float64Array(1024),
    lng: new Float64Array(1024),
    dbhInches: new Float64Array(1024),
    genus: new Uint16Array(1024),
    genera: [""],
  };
  private readonly generaIndex = new Map<string, number>([["", 0]]);

  push(lat: number, lng: number, dbhInches: number, genus: string): void {
    const table = this.table;
    if (table.length === table.lat.length) {
      this.grow(table.length * 2);
    }
    let index = this.generaIndex.get(genus);
    if (index === undefined) {
      index = table.genera.length;
      if (index > 0xffff) {
        throw new Error("more than 65,536 genera");
      }
      table.genera.push(genus);
      this.generaIndex.set(genus, index);
    }
    table.lat[table.length] = lat;
    table.lng[table.length] = lng;
    table.dbhInches[table.length] = dbhInches;
    table.genus[table.length] = index;
    table.length += 1;
  }

  finish(): TreeTable {
    this.grow(this.table.length);
    return this.table;
  }

  private grow(size: number): void {
    const table = this.table;
    const resized = <Array extends Float64Array | Uint16Array>(
      array: Array,
    ): Array => {
      const next = new (array.constructor as new (length: number) => Array)(
        size,
      );
      next.set(array.subarray(0, Math.min(size, table.length)));
      return next;
    };
    table.lat = resized(table.lat);
    table.lng = resized(table.lng);
    table.dbhInches = resized(table.dbhInches);
    table.genus = resized(table.genus);
  }
}

export function treeTableOf(trees: Iterable<Tree>): TreeTable {
  const builder = new TreeTableBuilder();
  for (const { lat, lng, dbhInches, genus } of trees) {
    builder.push(lat, lng, dbhInches, genus);
  }
  return builder.finish();
}
