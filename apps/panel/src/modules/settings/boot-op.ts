import { settings } from "@seylo/ops";
import { implement } from "../../ops/implement";
import { readBoot } from "./boot";

export const boot = implement(settings.boot, (_input, ctx) => readBoot(ctx.db));
