// Projects: create, list, read, rename, describe, set an image and delete,
// plus each person's sidebar state (collapsed, order). Services inside a project are the
// services module.

import { defineModule } from "../module";
import { create } from "./create";
import { remove } from "./delete";
import { get } from "./get";
import { removeImage, setImage } from "./image";
import { list } from "./list";
import { reorder, setCollapsed } from "./prefs";
import { update } from "./update";

export default defineModule({ name: "projects", ops: [create, get, list, remove, update, setCollapsed, reorder, setImage, removeImage] });
