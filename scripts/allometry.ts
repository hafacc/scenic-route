// Crown from trunk diameter, per McPherson, van Doorn & Peper 2016 (USDA GTR-PSW-253), whose fits
// differ by climate region in both coefficients and equation form; only sizes the genus dots.

// Registers record dbh in whole inches; the published equations take centimeters.
export const CM_PER_INCH = 2.54;

export type CrownAllometry =
  | {
      // GTR-PSW-253's `loglogw1`: exp(a + b*ln(ln(dbh_cm + 1)) + mse/2); mse/2 is Baskerville's.
      readonly form: "loglog";
      readonly a: number;
      readonly b: number;
      readonly logBiasCorrection: number;
      readonly source: string;
    }
  | {
      // GTR-PSW-253's `quad`: a + b*dbh_cm + c*dbh_cm^2; turns over past the fitted trunk sizes.
      readonly form: "quad";
      readonly a: number;
      readonly b: number;
      readonly c: number;
      readonly source: string;
    };

export function crownDiameterMeters(
  allometry: CrownAllometry,
  dbhInches: number,
): number {
  const cm = dbhInches * CM_PER_INCH;
  if (allometry.form === "loglog") {
    return Math.exp(
      allometry.a +
        allometry.b * Math.log(Math.log(cm + 1)) +
        allometry.logBiasCorrection,
    );
  } else {
    // Held at the vertex, since past it the crown shrinks; SF's is at a real 101.5 cm.
    const vertex = -allometry.b / (2 * allometry.c);
    const held = allometry.c < 0 ? Math.min(cm, vertex) : cm;
    return Math.max(
      0,
      allometry.a + allometry.b * held + allometry.c * held * held,
    );
  }
}

// NoEast region, fitted on Queens street trees; London planetree, R² 0.94 over 53 trees.
export const NOEAST_LONDON_PLANE: CrownAllometry = {
  form: "loglog",
  a: -0.75195,
  b: 2.41418,
  logBiasCorrection: 0.01977 / 2,
  source:
    "McPherson, van Doorn & Peper 2016 (USDA GTR-PSW-253), NoEast London planetree",
};

// NoCalC region, fitted on Berkeley street trees; London planetree, R² 0.95 over 69 trees.
export const NOCALC_LONDON_PLANE: CrownAllometry = {
  form: "quad",
  a: 0.69918,
  b: 0.36544,
  c: -0.0018,
  source:
    "McPherson, van Doorn & Peper 2016 (USDA GTR-PSW-253), NoCalC London planetree",
};
