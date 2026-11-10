// "Popular images": a row of single-image apps from Docker Hub on the
// Templates page. Each card opens the same prefilled form as a search
// result, with the curated port, volumes and env where the image needs them.

import { t } from "../../i18n/t";
import { TemplateLogo } from "../templates/template-logo";
import type { HubTarget } from "./image-dialog";
import { popularImages } from "./popular";

export function PopularRow({ onPick }: { onPick: (target: HubTarget) => void }) {
  return (
    <section aria-labelledby="popular-images" className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <h2 id="popular-images" className="m-0 text-[14.5px] font-semibold text-foreground">
          {t("dockerHub.popular")}
        </h2>
        <span className="text-[12.5px] text-muted-foreground">{t("dockerHub.popularHint")}</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(200px,100%),1fr))] gap-2.5">
        {popularImages.map((image) => (
          <button
            key={image.id}
            type="button"
            title={t(image.description)}
            onClick={() =>
              onPick({
                repository: image.repository,
                description: t(image.description),
                ...(image.logo ? { logoUrl: image.logo } : {}),
                ...(image.port ? { port: image.port } : {}),
                ...(image.volumes ? { volumes: image.volumes } : {}),
                ...(image.env ? { env: image.env } : {}),
              })
            }
            className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-card border-0 bg-card px-3 py-2.5 text-left text-foreground shadow-card transition-shadow hover:shadow-popover"
          >
            <TemplateLogo slug={image.id} name={image.name} logoUrl={image.logo ?? null} size={30} />
            <span className="flex min-w-0 flex-col">
              <b className="truncate text-[13px] font-semibold">{image.name}</b>
              <span className="truncate font-mono text-[11px] text-muted-foreground">{image.repository}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
