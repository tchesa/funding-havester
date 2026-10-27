// Worker threads don't inherit the tsx loader hooks; register them before loading the TS worker.
import { register } from "tsx/esm/api";
register();
await import("./worker.ts");
