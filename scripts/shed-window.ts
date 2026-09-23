// Prints only the first DOB day `update-sheds` must read; package.json uses it to size the clone.

import { shedWindow } from "./update-sheds";

console.log(await shedWindow());
