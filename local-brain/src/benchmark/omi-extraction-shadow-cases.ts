export type OmiExtractionShadowCategory =
  | "relationship_transition"
  | "person_role_association"
  | "active_project"
  | "current_routine"
  | "media_reference"
  | "temporal_change"
  | "community_network";

export interface OmiExtractionShadowRelation {
  readonly source: string;
  readonly predicate: string;
  readonly target: string;
}

export interface OmiExtractionShadowExpectedStructure {
  readonly name: "relationship_support" | "project_support" | "routine_support" | "transition_support" | "media_support";
  readonly terms: readonly string[];
}

export interface OmiExtractionShadowCase {
  readonly name: string;
  readonly category: OmiExtractionShadowCategory;
  readonly sourcePath: string;
  readonly text: string;
  readonly expectedEntities: readonly string[];
  readonly expectedRelations: readonly OmiExtractionShadowRelation[];
  readonly expectedSupportFamilies: readonly string[];
  readonly expectedNarrativeFrames: readonly string[];
  readonly expectedStructures: readonly OmiExtractionShadowExpectedStructure[];
}

export function omiExtractionShadowCases(): readonly OmiExtractionShadowCase[] {
  return [
    {
      name: "lauren_departure_transition",
      category: "relationship_transition",
      sourcePath:
        "/Users/evilone/Library/Application Support/AI-Brain/omi-archive/normalized/2026/03/27/2026-03-27T03-55-31Z__omi__3e1e19c6-2d94-426a-bfa2-3ddcb06e8227.md",
      text:
        "My recent relationship change was when Lauren left Thailand on 10/18/2025. We spent much of 2025 together in Chiang Mai, then she flew back to the US to Bend, Oregon and we have not really talked since.",
      expectedEntities: ["Lauren", "Thailand", "Chiang Mai", "Bend", "Oregon"],
      expectedRelations: [],
      expectedSupportFamilies: ["relationship", "temporal_event"],
      expectedNarrativeFrames: ["relationship", "temporal"],
      expectedStructures: [
        { name: "relationship_support", terms: ["Lauren"] },
        { name: "transition_support", terms: ["Lauren", "10/18/2025", "Bend"] }
      ]
    },
    {
      name: "dan_weave_friend_network",
      category: "community_network",
      sourcePath:
        "/Users/evilone/Library/Application Support/AI-Brain/omi-archive/normalized/2026/03/27/2026-03-27T03-34-28Z__omi__f63045bb-cc29-45ac-a746-538a4656db2e.md",
      text:
        "I met Dan at a weekly coworking meetup at Weave Artisan Society in Chiang Mai. Dan later introduced Gumi, and Dan has connected me with a wide circle of friends here.",
      expectedEntities: ["Dan", "Gumi", "Weave Artisan Society", "Chiang Mai"],
      expectedRelations: [],
      expectedSupportFamilies: ["relationship", "activity_participation"],
      expectedNarrativeFrames: ["relationship", "activity"],
      expectedStructures: [
        { name: "relationship_support", terms: ["Dan", "Gumi"] }
      ]
    },
    {
      name: "omi_two_way_role_shift",
      category: "person_role_association",
      sourcePath:
        "/Users/evilone/Library/Application Support/AI-Brain/omi-archive/normalized/2026/03/27/2026-03-27T07-41-31Z__omi__19fdfdfb-d639-423b-be65-9edd11f727a3.md",
      text:
        "Lauren and I no longer talk. Omi and I have become close friends, and I now work for him as adviser slash CTO of his company Two Way. We have grown the friendship by working together and hiking over the last few months in 2026.",
      expectedEntities: ["Lauren", "Omi", "Two Way"],
      expectedRelations: [{ source: "Omi", predicate: "member_of", target: "Two Way" }],
      expectedSupportFamilies: ["relationship", "project_focus"],
      expectedNarrativeFrames: ["relationship", "fact"],
      expectedStructures: [
        { name: "relationship_support", terms: ["Lauren", "Omi"] },
        { name: "project_support", terms: ["Two Way", "CTO"] }
      ]
    },
    {
      name: "memoir_graph_project",
      category: "active_project",
      sourcePath:
        "/Users/evilone/Library/Application Support/AI-Brain/omi-archive/normalized/2026/03/27/2026-03-27T07-41-31Z__omi__19fdfdfb-d639-423b-be65-9edd11f727a3.md",
      text:
        "Ben and I talked about the memoir AI engine and how to create the knowledge graph using a Postgres database and entity extraction to build a life graph for the memoirs project.",
      expectedEntities: ["Ben", "Postgres"],
      expectedRelations: [],
      expectedSupportFamilies: ["project_focus"],
      expectedNarrativeFrames: ["fact"],
      expectedStructures: [
        { name: "project_support", terms: ["memoir AI engine", "knowledge graph", "Postgres"] }
      ]
    },
    {
      name: "current_project_stack",
      category: "active_project",
      sourcePath:
        "/Users/evilone/Library/Application Support/AI-Brain/omi-archive/normalized/2026/03/27/2026-03-27T03-44-24Z__omi__97364493-9f90-46ac-b414-1062c729fc90.md",
      text:
        "I am working with Well Inked on a memoir-style engine, with Omi on Two Way for a pilot association platform, personally on Preset Kitchen, and also on an AI brain to help with memory and organization.",
      expectedEntities: ["Well Inked", "Omi", "Two Way", "Preset Kitchen", "AI brain"],
      expectedRelations: [{ source: "Omi", predicate: "member_of", target: "Two Way" }],
      expectedSupportFamilies: ["project_focus"],
      expectedNarrativeFrames: ["fact"],
      expectedStructures: [
        { name: "project_support", terms: ["Well Inked", "memoir-style engine"] },
        { name: "project_support", terms: ["Two Way", "pilot association"] }
      ]
    },
    {
      name: "routine_morning_flow",
      category: "current_routine",
      sourcePath:
        "/Users/evilone/Library/Application Support/AI-Brain/omi-archive/normalized/2026/03/28/2026-03-28T08-52-32Z__omi__a6effac2-e74d-43b9-8b59-4bda0869c1d8.md",
      text:
        "I usually wake around 7 to 8 AM, make coffee, check AI news on Reddit, review emails and tasks, and start work around 10 AM either at home or a coworking space. I split work across Two Way and Well Inked and take a midday break for the gym, yoga, or a walk.",
      expectedEntities: ["Two Way", "Well Inked", "Reddit"],
      expectedRelations: [],
      expectedSupportFamilies: ["routine", "project_focus"],
      expectedNarrativeFrames: ["fact"],
      expectedStructures: [
        { name: "routine_support", terms: ["7", "coffee", "Reddit"] },
        { name: "project_support", terms: ["Two Way"] }
      ]
    },
    {
      name: "yesterday_project_recap",
      category: "active_project",
      sourcePath:
        "/Users/evilone/Library/Application Support/AI-Brain/omi-archive/normalized/2026/03/28/2026-03-28T01-29-10Z__omi__ce78791a-9a8b-4949-88b6-15d6a6f2598c.md",
      text:
        "Yesterday I worked on an AI brain using Postgres and relationship graphs, on Preset Kitchen, on Bumblebee for Well Inked, and as CTO for Two Way owned by Omi Gummi while redesigning the website and planning a Webflow migration.",
      expectedEntities: ["AI brain", "Postgres", "Preset Kitchen", "Bumblebee", "Well Inked", "Two Way", "Omi Gummi", "Webflow"],
      expectedRelations: [{ source: "Omi Gummi", predicate: "member_of", target: "Two Way" }],
      expectedSupportFamilies: ["project_focus"],
      expectedNarrativeFrames: ["fact"],
      expectedStructures: [
        { name: "project_support", terms: ["AI brain", "Postgres"] },
        { name: "project_support", terms: ["Preset Kitchen"] }
      ]
    },
    {
      name: "movies_and_shows_recently",
      category: "media_reference",
      sourcePath:
        "/Users/evilone/Library/Application Support/AI-Brain/omi-archive/normalized/2026/03/21/2026-03-21T13-08-01Z__omi__6113df6e-edf1-4bc1-b97e-7be19d046679.md",
      text:
        "We talked about Sinners, Chainsaw Man, Avatar, and Slow Horses, including seeing Sinners at Ben's house in Chiang Mai and how it reminded us of From Dusk Till Dawn.",
      expectedEntities: ["Sinners", "Chainsaw Man", "Avatar", "Slow Horses", "Ben", "Chiang Mai", "From Dusk Till Dawn"],
      expectedRelations: [],
      expectedSupportFamilies: ["media_reference"],
      expectedNarrativeFrames: ["fact"],
      expectedStructures: [
        { name: "media_support", terms: ["Sinners"] },
        { name: "media_support", terms: ["Slow Horses"] }
      ]
    },
    {
      name: "ai_meetup_and_coffee_stop",
      category: "community_network",
      sourcePath:
        "/Users/evilone/Library/Application Support/AI-Brain/omi-archive/normalized/2026/03/21/2026-03-21T11-09-33Z__omi__5501c431-8b0b-42ed-875b-16fc83cce027.md",
      text:
        "I attended a two-hour AI and LLM meetup at the Canass Hotel in Chiang Mai, made friends through coworking and meetups including Dan, Gumi, Tim, and Ben, then rode my scooter to Living a Dream coffee and caught up with Tim.",
      expectedEntities: ["Canass Hotel", "Chiang Mai", "Dan", "Gumi", "Tim", "Ben", "Living a Dream"],
      expectedRelations: [],
      expectedSupportFamilies: ["activity_participation", "relationship"],
      expectedNarrativeFrames: ["activity", "relationship"],
      expectedStructures: [
        { name: "relationship_support", terms: ["Dan", "Tim"] }
      ]
    },
    {
      name: "istanbul_pilot_trip",
      category: "temporal_change",
      sourcePath:
        "/Users/evilone/Library/Application Support/AI-Brain/omi-archive/normalized/2026/03/21/2026-03-21T11-41-56Z__omi__fa0bf310-64a2-4f55-a4fc-c8eb5a41aecc.md",
      text:
        "Likely plans for tomorrow include brunch with Omi and Dan, and in April there is a planned trip to Istanbul, Turkey at the end of April for a Pilots Association conference.",
      expectedEntities: ["Omi", "Dan", "Istanbul", "Turkey", "Pilots Association", "April"],
      expectedRelations: [],
      expectedSupportFamilies: ["temporal_event", "relationship"],
      expectedNarrativeFrames: ["plan", "temporal"],
      expectedStructures: [
        { name: "transition_support", terms: ["Istanbul", "April"] }
      ]
    },
    {
      name: "lauren_departure_exact_date",
      category: "temporal_change",
      sourcePath:
        "/Users/evilone/Library/Application Support/AI-Brain/omi-archive/normalized/2026/03/27/2026-03-27T03-43-33Z__omi__c267ad28-741c-4f46-8b5f-e8b9c6464f03.md",
      text:
        "On October 18, 2025, Lauren left Chiang Mai, Thailand to fly back to the United States, specifically to Bend, Oregon.",
      expectedEntities: ["October 18, 2025", "Lauren", "Chiang Mai", "Thailand", "United States", "Bend", "Oregon"],
      expectedRelations: [],
      expectedSupportFamilies: ["temporal_event", "relationship"],
      expectedNarrativeFrames: ["temporal", "relationship"],
      expectedStructures: [
        { name: "transition_support", terms: ["Lauren", "October 18, 2025", "Bend"] }
      ]
    },
    {
      name: "john_samui_role",
      category: "person_role_association",
      sourcePath:
        "/Users/evilone/Library/Application Support/AI-Brain/omi-archive/normalized/2026/03/27/2026-03-27T03-36-47Z__omi__73f02876-22d9-485c-964f-6e4a92152b71.md",
      text:
        "John is the owner of the Samui Experience, a private Burning Man in the jungle style park in Koh Samui where I created projected art on statues.",
      expectedEntities: ["John", "Samui Experience", "Koh Samui", "Burning Man"],
      expectedRelations: [],
      expectedSupportFamilies: ["relationship", "activity_participation"],
      expectedNarrativeFrames: ["fact", "activity"],
      expectedStructures: [
        { name: "relationship_support", terms: ["John"] }
      ]
    }
  ];
}
