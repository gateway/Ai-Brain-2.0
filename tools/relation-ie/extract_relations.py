#!/usr/bin/env python3

import json
import os
import re
import sys
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


DEFAULT_ENTITY_LABELS = [
    "person",
    "organization",
    "place",
    "location",
    "city",
    "country",
    "project",
    "media",
    "other",
]

DEFAULT_RELATION_LABELS = [
    "friend of",
    "works with",
    "works at",
    "worked at",
    "works on",
    "lives in",
    "lived in",
    "member of",
    "met through",
    "sibling of",
    "romantic partner of",
]

_GLINER_MODELS: Dict[Tuple[str, str], Any] = {}
_SPACY_MODELS: Dict[str, Any] = {}
_SPAN_MARKER_MODELS: Dict[str, Any] = {}


@dataclass(frozen=True)
class SceneInput:
    scene_index: int
    text: str


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def _normalize_entity_label(label: str) -> str:
    normalized = _normalize_text(re.split(r"\s*[:]{1,2}\s*", label, maxsplit=1)[0]).lower()
    mapping = {
        "person": "person",
        "people": "person",
        "person-other": "person",
        "per": "person",
        "organization": "org",
        "organisation": "org",
        "org": "org",
        "company": "org",
        "location": "place",
        "place": "place",
        "gpe": "place",
        "loc": "place",
        "city": "place",
        "country": "place",
        "state": "place",
        "facility": "place",
        "project": "project",
        "work_of_art": "media",
        "media": "media",
        "movie": "media",
        "film": "media",
        "other": "other",
    }
    return mapping.get(normalized, normalized)


def _normalize_relation_label(label: str) -> Optional[Tuple[str, Dict[str, Any]]]:
    normalized = _normalize_text(re.split(r"\s*[:]{1,2}\s*", label, maxsplit=1)[0]).lower()
    metadata: Dict[str, Any] = {}

    if normalized in {"friend of", "friend", "friends with"}:
        return "friend_of", metadata
    if normalized in {"works with", "coworker of", "collaborates with"}:
        return "works_with", metadata
    if normalized in {"works at", "employed by"}:
        return "works_at", metadata
    if normalized in {"worked at", "previously worked at"}:
        return "worked_at", metadata
    if normalized in {"works on", "working on"}:
        return "works_on", metadata
    if normalized in {"member of"}:
        return "member_of", metadata
    if normalized in {"met through"}:
        return "met_through", metadata
    if normalized in {"sibling of", "brother of", "sister of"}:
        return "sibling_of", metadata
    if normalized in {"lives in", "resides in", "currently in"}:
        return "lives_in", metadata
    if normalized in {"lived in", "used to live in"}:
        return "lived_in", metadata
    if normalized in {"romantic partner of", "partner of", "dating", "dated", "girlfriend of", "boyfriend of"}:
        metadata["relationship_kind"] = "romantic"
        return "was_with", metadata
    return None


def _unique_entities(entities: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = set()
    unique: List[Dict[str, Any]] = []
    for entity in entities:
      key = (
          _normalize_text(str(entity.get("text", ""))).lower(),
          _normalize_entity_label(str(entity.get("label", ""))),
          entity.get("start"),
          entity.get("end"),
      )
      if key in seen:
          continue
      seen.add(key)
      unique.append(entity)
    return unique


def _unique_relations(relations: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = set()
    unique: List[Dict[str, Any]] = []
    for relation in relations:
        key = (
            _normalize_text(str(relation.get("source", ""))).lower(),
            _normalize_text(str(relation.get("target", ""))).lower(),
            _normalize_text(str(relation.get("relation", ""))).lower(),
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(relation)
    return unique


def _heuristic_relations(text: str, entities: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized_text = _normalize_text(text)
    people = [entity for entity in entities if _normalize_entity_label(str(entity.get("label", ""))) == "person"]
    places = [entity for entity in entities if _normalize_entity_label(str(entity.get("label", ""))) == "place"]
    orgs = [entity for entity in entities if _normalize_entity_label(str(entity.get("label", ""))) == "org"]
    projects = [entity for entity in entities if _normalize_entity_label(str(entity.get("label", ""))) == "project"]

    relations: List[Dict[str, Any]] = []

    def add_relation(source: Dict[str, Any], relation: str, target: Dict[str, Any], score: float, **metadata: Any) -> None:
        if _normalize_text(str(source.get("text", ""))).lower() == _normalize_text(str(target.get("text", ""))).lower():
            return
        payload = {
            "source": source.get("text"),
            "target": target.get("text"),
            "relation": relation,
            "score": score,
        }
        payload.update(metadata)
        relations.append(payload)

    if re.search(r"\b(friend|friends|buddy|close friend)\b", normalized_text, re.I) and len(people) >= 2:
        for left, right in zip(people, people[1:]):
            add_relation(left, "friend of", right, 0.72)

    if re.search(r"\b(work(?:ed|ing)? with|cowork(?:er|ers)|colleague)\b", normalized_text, re.I) and len(people) >= 2:
        for left, right in zip(people, people[1:]):
            add_relation(left, "works with", right, 0.74)

    if re.search(r"\b(work(?:s|ed)? at|employed by|joined)\b", normalized_text, re.I) and people and orgs:
        for person in people[:2]:
            for org in orgs[:2]:
                relation = "worked at" if re.search(r"\bworked at|used to work at|previously\b", normalized_text, re.I) else "works at"
                add_relation(person, relation, org, 0.76)

    if re.search(r"\b(project|roadmap|build|working on)\b", normalized_text, re.I) and people and projects:
        for person in people[:2]:
            for project in projects[:2]:
                add_relation(person, "works on", project, 0.71)

    if re.search(r"\b(live|lived|moved|relocated|stayed in|resides)\b", normalized_text, re.I) and people and places:
        relation = "lived in" if re.search(r"\blived|used to live|moved from|previously\b", normalized_text, re.I) else "lives in"
        for person in people[:2]:
            add_relation(person, relation, places[0], 0.75)

    if re.search(r"\b(brother|sister|sibling)\b", normalized_text, re.I) and len(people) >= 2:
        add_relation(people[0], "sibling of", people[1], 0.7)

    if re.search(r"\b(partner|girlfriend|boyfriend|dating|dated|romantic)\b", normalized_text, re.I) and len(people) >= 2:
        add_relation(people[0], "romantic partner of", people[1], 0.71, relationship_kind="romantic")

    return _unique_relations(relations)


def _load_gliner_model(model_id: str, device: str) -> Any:
    cache_key = (model_id, device)
    if cache_key not in _GLINER_MODELS:
        from gliner import GLiNER

        _GLINER_MODELS[cache_key] = GLiNER.from_pretrained(model_id)
    return _GLINER_MODELS[cache_key]


def _described_labels(labels: List[str], descriptions: Dict[str, str]) -> List[str]:
    described: List[str] = []
    for label in labels:
        description = _normalize_text(str(descriptions.get(label, "")))
        if description:
            described.append(f"{label} :: {description}")
        else:
            described.append(label)
    return described


def _run_gliner_relex(
    scene: SceneInput,
    model_id: str,
    device: str,
    entity_labels: List[str],
    relation_labels: List[str],
    entity_descriptions: Dict[str, str],
    relation_descriptions: Dict[str, str],
    thresholds: Dict[str, float],
) -> Dict[str, Any]:
    model = _load_gliner_model(model_id, device)
    entity_threshold = float(thresholds.get("entity", 0.45))
    relation_threshold = float(thresholds.get("relation", 0.45))
    entities, relations = model.inference(
        scene.text,
        labels=_described_labels(entity_labels, entity_descriptions),
        relations=_described_labels(relation_labels, relation_descriptions),
        threshold=entity_threshold,
        relation_threshold=relation_threshold,
        batch_size=1,
    )
    scene_entities = entities[0] if entities else []
    scene_relations = relations[0] if relations else []
    return {
        "entities": _unique_entities([
            {
                "text": entity.get("text"),
                "label": _normalize_entity_label(str(entity.get("label", ""))),
                "score": float(entity.get("score", 0.0)),
                "start": entity.get("start"),
                "end": entity.get("end"),
            }
            for entity in scene_entities
        ]),
        "relations": _unique_relations([
            {
                "source": relation.get("head", {}).get("text"),
                "target": relation.get("tail", {}).get("text"),
                "relation": _normalize_text(str(relation.get("relation", ""))).split("::", 1)[0].strip(),
                "score": float(relation.get("score", 0.0)),
                "start": relation.get("head", {}).get("start"),
                "end": relation.get("tail", {}).get("end"),
            }
            for relation in scene_relations
        ]),
        "warnings": [],
        "schema_version": "gliner_relex_dynamic_v1",
        "thresholds": {
            "entity": entity_threshold,
            "adjacency": float(thresholds.get("adjacency", entity_threshold)),
            "relation": relation_threshold,
        },
    }


def _run_gliner2(scene: SceneInput, model_id: str, device: str, entity_labels: List[str], thresholds: Dict[str, float]) -> Dict[str, Any]:
    model = _load_gliner_model(model_id, device)
    entity_threshold = float(thresholds.get("entity", 0.45))
    entities = model.predict_entities(scene.text, entity_labels, threshold=entity_threshold)
    normalized_entities = _unique_entities([
        {
            "text": entity.get("text"),
            "label": _normalize_entity_label(str(entity.get("label", ""))),
            "score": float(entity.get("score", 0.0)),
            "start": entity.get("start"),
            "end": entity.get("end"),
        }
        for entity in entities
    ])
    return {
        "entities": normalized_entities,
        "relations": _heuristic_relations(scene.text, normalized_entities),
        "warnings": [],
        "schema_version": "gliner2_dynamic_v1",
        "thresholds": {
            "entity": entity_threshold,
            "adjacency": float(thresholds.get("adjacency", entity_threshold)),
            "relation": float(thresholds.get("relation", entity_threshold)),
        },
    }


def _run_spacy(scene: SceneInput, model_id: str) -> Dict[str, Any]:
    if model_id not in _SPACY_MODELS:
        import spacy

        _SPACY_MODELS[model_id] = spacy.load(model_id)
    nlp = _SPACY_MODELS[model_id]
    doc = nlp(scene.text)
    entities = _unique_entities([
        {
            "text": ent.text,
            "label": _normalize_entity_label(ent.label_),
            "score": 0.68,
            "start": ent.start_char,
            "end": ent.end_char,
        }
        for ent in doc.ents
    ])
    return {
        "entities": entities,
        "relations": _heuristic_relations(scene.text, entities),
        "warnings": [],
        "schema_version": "spacy_fallback_v1",
        "thresholds": {
            "entity": 0.68,
            "adjacency": 0.68,
            "relation": 0.71,
        },
    }


def _run_span_marker(scene: SceneInput, model_id: str) -> Dict[str, Any]:
    if model_id not in _SPAN_MARKER_MODELS:
        from span_marker import SpanMarkerModel

        _SPAN_MARKER_MODELS[model_id] = SpanMarkerModel.from_pretrained(model_id)
    model = _SPAN_MARKER_MODELS[model_id]
    entities = model.predict(scene.text)
    normalized_entities = _unique_entities([
        {
            "text": entity.get("span"),
            "label": _normalize_entity_label(str(entity.get("label", ""))),
            "score": float(entity.get("score", 0.0)),
            "start": entity.get("char_start_index"),
            "end": entity.get("char_end_index"),
        }
        for entity in entities
    ])
    return {
        "entities": normalized_entities,
        "relations": _heuristic_relations(scene.text, normalized_entities),
        "warnings": [],
        "schema_version": "span_marker_fallback_v1",
        "thresholds": {
            "entity": 0.5,
            "adjacency": 0.5,
            "relation": 0.71,
        },
    }


def _unavailable(extractor: str, reason: str) -> Dict[str, Any]:
    return {"entities": [], "relations": [], "warnings": [reason], "extractor": extractor}


def _run_eval_only_placeholder(extractor: str, scene: SceneInput) -> Dict[str, Any]:
    _ = scene
    return _unavailable(extractor, f"{extractor} is eval-only and not installed in .venv-brain")


def _run_extractor(
    extractor: str,
    scene: SceneInput,
    device: str,
    models: Dict[str, str],
    entity_labels: List[str],
    relation_labels: List[str],
    entity_descriptions: Dict[str, str],
    relation_descriptions: Dict[str, str],
    thresholds: Dict[str, float],
) -> Dict[str, Any]:
    try:
        if extractor == "gliner_relex":
            return _run_gliner_relex(
                scene,
                models["gliner_relex"],
                device,
                entity_labels,
                relation_labels,
                entity_descriptions,
                relation_descriptions,
                thresholds,
            )
        if extractor == "gliner2":
            return _run_gliner2(scene, models["gliner2"], device, entity_labels, thresholds)
        if extractor == "spacy":
            return _run_spacy(scene, models["spacy"])
        if extractor == "span_marker":
            return _run_span_marker(scene, models["span_marker"])
        if extractor in {"glirel", "flair", "stanza"}:
            return _run_eval_only_placeholder(extractor, scene)
        return _unavailable(extractor, f"Unsupported extractor: {extractor}")
    except Exception as exc:  # pragma: no cover - surfaced as tool/runtime metadata
        return _unavailable(extractor, f"{extractor} failed: {exc}")


def main() -> int:
    payload = json.load(sys.stdin)
    device = payload.get("device", "cpu")
    extractors = payload.get("extractors") or ["gliner_relex", "gliner2", "spacy", "span_marker"]
    entity_labels = payload.get("entity_labels") or DEFAULT_ENTITY_LABELS
    relation_labels = payload.get("relation_labels") or DEFAULT_RELATION_LABELS
    entity_descriptions = payload.get("entity_descriptions") or {}
    relation_descriptions = payload.get("relation_descriptions") or {}
    thresholds = payload.get("thresholds") or {}
    model_config = payload.get("models") or {}

    models = {
        "gliner_relex": model_config.get("gliner_relex", "knowledgator/gliner-relex-large-v0.5"),
        "gliner2": model_config.get("gliner2", "fastino/gliner2-base-v1"),
        "spacy": model_config.get("spacy", "en_core_web_sm"),
        "span_marker": model_config.get("span_marker", "tomaarsen/span-marker-roberta-large-ontonotes5"),
    }

    scenes = [SceneInput(scene_index=int(item["scene_index"]), text=str(item["text"])) for item in payload.get("scenes", [])]

    response: Dict[str, Any] = {"scenes": [], "errors": []}
    for scene in scenes:
        scene_result = {"scene_index": scene.scene_index, "extractors": []}
        for extractor in extractors:
            result = _run_extractor(
                extractor,
                scene,
                device,
                models,
                entity_labels,
                relation_labels,
                entity_descriptions,
                relation_descriptions,
                thresholds,
            )
            scene_result["extractors"].append(
                {
                    "extractor": extractor,
                    "model_id": models.get(extractor),
                    "schema_version": result.get("schema_version"),
                    "thresholds": result.get("thresholds"),
                    "entities": result["entities"],
                    "relations": result["relations"],
                    "warnings": result["warnings"],
                }
            )
        response["scenes"].append(scene_result)

    json.dump(response, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
