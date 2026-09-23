// Local-only preview fixture for the time tracker's Phase 2/3 screens.
//
// The real Supabase tables (production_imports, cabinets, room_extras,
// cabinet_accessories, time_entries.quantity_completed, etc.) have never
// been executed against the live database — this preview runs entirely on localStorage
// so it can be tried out before committing to that step. See
// docs/time-tracker.md and the project_time_tracker_phase2_groundwork
// memory for the reasoning behind every figure here.
//
// The Kitchen cabinet list below is the REAL DA1277 Anna Reid A3 item
// table (Item # / Description / Width / Height / Depth), with every
// "...ShP Skirting..." row already excluded — see 0008_cabinets.sql for
// why. type_guess is this preview's best-effort match against the seeded
// cabinet_types list (0005_cabinet_types.sql); anything without a clean
// match is flagged needs_review, same as a real import would flag it.

export const SAMPLE_JOB = { da_number: "DA1277", client_name: "Anna Reid" };
export const SAMPLE_ROOM = "Kitchen";

export const SAMPLE_CABINET_TYPES = [
  "Base 3 Drawers 60", "Base Dwr Line 1D-PD 110", "Base Sink PD 80",
  "Base Intg DW Door 67", "Base Intg Fridge 67", "Base Double Bin 48",
  "Base 2 Oak Chopping Boards", "Base Highline SD", "Base Highline PD",
  "Tall PD 80", "Tall SD 67", "Tall FFR Housing", "Single Oven DD-1DRW",
  "Counter Top 4D Bi-Fold 120", "Panel", "Extractor Housing", "Turned Post",
  "Open Shelf", "Open Base Unit", "Primed Unit Ship Out", "Painted Unit Ship Out",
];

// { item, description, width, height, depth, typeGuess }
// typeGuess === null means: no seeded type is close enough, needs a new one.
export const SAMPLE_CABINETS = [
  { item: "1",    description: "Single Oven & Integrated Combi Microwave", width: 680,  height: 2150, depth: 600, typeGuess: null },
  { item: "1.1",  description: "Countertop ShP LH",                        width: 15,   height: 2140, depth: 575, typeGuess: "Panel" },
  { item: "2",    description: "Base Highline SD",                         width: 587,  height: 880,  depth: 600, typeGuess: "Base Highline SD" },
  { item: "3",    description: "Base Triple Bin",                          width: 630,  height: 880,  depth: 600, typeGuess: "Base Double Bin 48" },
  { item: "4",    description: "Base Belfast Sink PD 97",                  width: 970,  height: 880,  depth: 600, typeGuess: "Base Sink PD 80" },
  { item: "5",    description: "Base Intg DW Door 67",                     width: 670,  height: 880,  depth: 600, typeGuess: "Base Intg DW Door 67" },
  { item: "6",    description: "Base 2 Oak Chopping Boards + 1 Oak Tray",  width: 205,  height: 880,  depth: 600, typeGuess: "Base 2 Oak Chopping Boards" },
  { item: "7",    description: "Floating Wall Shelf",                      width: 740,  height: 40,   depth: 210, typeGuess: "Open Shelf" },
  { item: "8",    description: "Base Highline PD",                         width: 985,  height: 880,  depth: 192, typeGuess: "Base Highline PD" },
  { item: "9",    description: "Floating Wall Shelf",                      width: 740,  height: 40,   depth: 210, typeGuess: "Open Shelf" },
  { item: "10",   description: "Base 3 Drawers",                           width: 785,  height: 880,  depth: 600, typeGuess: "Base 3 Drawers 60" },
  { item: "11",   description: "Bora Drawer Unit",                         width: 900,  height: 880,  depth: 600, typeGuess: null },
  { item: "12",   description: "Base 3 Drawers",                           width: 785,  height: 880,  depth: 600, typeGuess: "Base 3 Drawers 60" },
  { item: "13",   description: "Floating Wall Shelf",                      width: 740,  height: 40,   depth: 210, typeGuess: "Open Shelf" },
  { item: "21",   description: "Base Drawer Line 2D-PD",                   width: 900,  height: 880,  depth: 600, typeGuess: "Base Dwr Line 1D-PD 110" },
  { item: "22",   description: "Base Drawer Line 2D-PD",                   width: 900,  height: 880,  depth: 600, typeGuess: "Base Dwr Line 1D-PD 110" },
  { item: "23",   description: "Base Intg Fridge 67",                      width: 670,  height: 880,  depth: 600, typeGuess: "Base Intg Fridge 67" },
  { item: "24",   description: "Counter Top 4D Bi-Fold 160",                width: 1600, height: 1240, depth: 400, typeGuess: "Counter Top 4D Bi-Fold 120" },
  { item: "26",   description: "Counter Top SD",                           width: 435,  height: 1240, depth: 400, typeGuess: null },
  { item: "26.1", description: "Countertop ShP RH",                        width: 15,   height: 1240, depth: 375, typeGuess: "Panel" },
  { item: "27",   description: "Counter Top SD",                           width: 435,  height: 1240, depth: 400, typeGuess: null },
  { item: "27.1", description: "Countertop ShP LH",                        width: 15,   height: 1240, depth: 375, typeGuess: "Panel" },
];

export const SAMPLE_EXCLUDED_COUNT = 8; // #6.1, #14, #14.1, #14.2, #15, #15.1, #21.1, #22.1

export const SAMPLE_ROOM_EXTRAS = [
  {
    kind: "skirting",
    metres: 18.1,
    calculation_notes:
      "Front of every floor-sitting cabinet (12.14m) + confirmed exposed sides #1/#21/#22/#26/#27 (2.6m) " +
      "+ island ends #14/#15, read from their own ShP-panel dimensions (est. 3.36m — office should confirm this last figure).",
  },
  {
    kind: "cornice",
    metres: 4.55,
    calculation_notes:
      "#1 (tall, >1800mm): front + left edge (1.28m). #24/#26/#27 (named \"Counter Top...\"): front of all three " +
      "plus #26/#27's exposed outer ends, all round the group (3.27m). No wall cabinets present in this room.",
  },
];

// { label, cabinetItem (null = TBC/unresolved), rawSpecText, productCode }
export const SAMPLE_ACCESSORIES = [
  { label: "Cutlery Divider", cabinetItem: "12", rawSpecText: "Cutlery Divider — #12 — Top Drawer", productCode: null },
  { label: "Utensils Divider", cabinetItem: "10", rawSpecText: "Utensils Divider — #10 — Top Drawer", productCode: null },
  { label: "Bins", cabinetItem: "3", rawSpecText: "Bins — #3 — 600 Triple Bin", productCode: "503.44.314" },
  { label: "Vegetable crate", cabinetItem: null, rawSpecText: "Vegetable crate — pantry #5 — 2no stained Affogato", productCode: null },
  { label: "Spice Draw Insert", cabinetItem: null, rawSpecText: "Spice Draw Insert — TBC", productCode: null },
  { label: "Knife Blocks", cabinetItem: null, rawSpecText: "Knife Blocks — TBC", productCode: null },
  { label: "Coffee Pod Insert", cabinetItem: null, rawSpecText: "Coffee Pod Insert — TBC", productCode: null },
  { label: "Spice/Jars Racks", cabinetItem: null, rawSpecText: "Spice/Jars Racks — TBC", productCode: null },
];

// The full real seeded team (0001_people.sql) — everyone, not just the
// workshop subset, since office people (Design and admin, Delivery and
// logistics) and fitters (Remakes and fix-ups) clock time too. PINs here
// are made up for this preview only — real people aren't seeded with a
// PIN in 0001_people.sql on purpose (a placeholder number in a migration
// would read as real data); real PINs get set per person via the
// ?admin=aliases screen before Phase 3 goes live for real.
export const SAMPLE_WORKSHOP_PEOPLE = [
  { name: "Harry", pin: "1111" },
  { name: "Jon", pin: "2222" },
  { name: "Tom", pin: "3333" },
  { name: "Mike", pin: "4444" },
  { name: "Jan", pin: "5555" },
  { name: "Jaxon", pin: "6666" },
  { name: "Josh", pin: "7777" },
  { name: "Wayne", pin: "8888" },
  { name: "Glenn", pin: "9999" },
  { name: "Mark", pin: "0000" },
  { name: "Steve", pin: "1212" },
  { name: "Thompson", pin: "1313" },
  { name: "Callum", pin: "1414" },
  { name: "Abi", pin: "1515" },
  { name: "Louise", pin: "1616" },
  { name: "Martin", pin: "1717" },
  { name: "Victoria", pin: "1818" },
  { name: "Becky", pin: "1919" },
];

// The 14 production stages (0006_stages.sql), confirmed against a real
// Clockify export (Helen & Alex Siviter-Platts, DA1198 — see
// docs/time-tracker.md "Frame and Door manufacture"). isCabinetStage
// drives whether a cabinet must be picked before clocking on. tracksQuantity
// (Frame/Door manufacture only) drives whether stopping the clock asks
// "how many did you complete" — real history shows these are batch work,
// never logged against one specific cabinet, unlike Cabinet bench/
// reassembly which always carry a cabinet number.
export const SAMPLE_STAGES = [
  { name: "CNC", isCabinetStage: false, tracksQuantity: false },
  { name: "Frame manufacture", isCabinetStage: false, tracksQuantity: true },
  { name: "Door manufacture", isCabinetStage: false, tracksQuantity: true },
  { name: "Cabinet bench", isCabinetStage: true, tracksQuantity: false },
  { name: "Drawer manufacture", isCabinetStage: false, tracksQuantity: false },
  { name: "Skirting and cornice manufacture", isCabinetStage: false, tracksQuantity: false },
  { name: "Spraying and finishing", isCabinetStage: false, tracksQuantity: false },
  { name: "Cabinet reassembly", isCabinetStage: true, tracksQuantity: false },
  { name: "Edgebanding", isCabinetStage: false, tracksQuantity: false },
  { name: "Timber machining", isCabinetStage: false, tracksQuantity: false },
  { name: "Production prep", isCabinetStage: false, tracksQuantity: false },
  { name: "Remakes and fix-ups", isCabinetStage: true, tracksQuantity: false },
  { name: "Delivery and logistics", isCabinetStage: false, tracksQuantity: false },
  { name: "Design and admin", isCabinetStage: false, tracksQuantity: false },
];
