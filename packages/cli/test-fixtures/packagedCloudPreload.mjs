import { createPackagedCloudFetch } from "./packagedCloudFetch.cjs";

globalThis.fetch = createPackagedCloudFetch(globalThis.fetch);
