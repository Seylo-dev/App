// The motion features the app animates with, loaded after the first paint
// (see MotionProvider). domMax instead of domAnimation because the sliding
// selection backgrounds and the toast stack use layout animations
// (layoutId, layout), which only domMax has.

import { domMax } from "motion/react";

export default domMax;
