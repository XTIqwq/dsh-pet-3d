// Entry for the self-contained Node three bundle used by the importer.
//
// The importer must run without any installed npm dependency (a `link:` install
// gets none), so the tolerant FBX loader and GLTFExporter are bundled together
// with three. `tools/node_modules/three` stays the source of truth for the
// version that actually produced the models (0.171 + the tolerant loader).
export * as THREE from 'three'
export { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.tolerant.js'
export { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
