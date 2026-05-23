#!/usr/bin/env python3

import json
import os
import re
import sys
from contextlib import redirect_stdout
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
    "venue",
    "team",
    "institution",
    "project",
    "product",
    "tool",
    "app",
    "initiative",
    "media",
    "book",
    "show",
    "song",
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
    "prefers",
    "favorite of",
    "owns",
    "bought",
    "supports",
    "advises",
    "inspired by",
    "caused by",
    "because of",
    "occurred on",
    "participated in",
    "family activity with",
    "about",
    "identity support of",
]

_GLINER_MODELS: Dict[Tuple[str, str], Any] = {}
_GLINER2_MODELS: Dict[Tuple[str, str], Any] = {}
_SPACY_MODELS: Dict[str, Any] = {}
_SPAN_MARKER_MODELS: Dict[str, Any] = {}


@dataclass(frozen=True)
class SceneInput:
    scene_index: int
    text: str


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def _safe_float(value: Any) -> Optional[float]:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if parsed != parsed:  # NaN
        return None
    return parsed


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
        "team": "org",
        "institution": "org",
        "employer": "org",
        "location": "place",
        "place": "place",
        "gpe": "place",
        "loc": "place",
        "city": "place",
        "country": "place",
        "state": "place",
        "facility": "place",
        "venue": "place",
        "region": "place",
        "project": "project",
        "product": "project",
        "tool": "project",
        "app": "project",
        "initiative": "project",
        "service": "project",
        "work_of_art": "media",
        "media": "media",
        "movie": "media",
        "film": "media",
        "book": "media",
        "show": "media",
        "song": "media",
        "album": "media",
        "series": "media",
        "podcast": "media",
        "band": "media",
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


def _collect_confidences(value: Any) -> List[float]:
    confidences: List[float] = []
    if isinstance(value, dict):
        for key, entry in value.items():
            if str(key).lower() in {"confidence", "score"}:
                parsed = _safe_float(entry)
                if parsed is not None:
                    confidences.append(parsed)
                continue
            confidences.extend(_collect_confidences(entry))
    elif isinstance(value, list):
        for entry in value:
            confidences.extend(_collect_confidences(entry))
    return confidences


def _attach_meta(value: Any, meta_key: str) -> Any:
    if not isinstance(value, dict):
        return value

    meta: Dict[str, Any] = {}
    for key, entry in value.items():
        if str(key).startswith("__"):
            continue
        confidences = _collect_confidences(entry)
        if confidences:
            meta[str(key)] = round(sum(confidences) / len(confidences), 4)

    if not meta:
        return value

    payload = dict(value)
    existing_meta = payload.get("__meta") if isinstance(payload.get("__meta"), dict) else {}
    payload["__meta"] = {**existing_meta, meta_key: meta}
    return payload


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


def _load_gliner2_model(model_id: str, device: str) -> Any:
    cache_key = (model_id, device)
    if cache_key not in _GLINER2_MODELS:
        from gliner2 import GLiNER2

        with redirect_stdout(sys.stderr):
            extractor = GLiNER2.from_pretrained(model_id)
        if device == "mps":
            extractor = extractor.to("mps")
        _GLINER2_MODELS[cache_key] = extractor
    return _GLINER2_MODELS[cache_key]


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
        "schema_version": "gliner_relex_v1",
        "thresholds": {
            "entity": entity_threshold,
            "adjacency": float(thresholds.get("adjacency", entity_threshold)),
            "relation": relation_threshold,
        },
    }


def _normalize_gliner2_entities(result: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw_entities = result.get("entities") if isinstance(result, dict) else {}
    normalized: List[Dict[str, Any]] = []
    if not isinstance(raw_entities, dict):
        return normalized

    for label, values in raw_entities.items():
        canonical_label = _normalize_entity_label(str(label))
        if isinstance(values, list):
            for value in values:
                if isinstance(value, dict):
                    normalized.append(
                        {
                            "text": value.get("text") or value.get("label") or value.get("value"),
                            "label": canonical_label,
                            "score": float(value.get("confidence", value.get("score", 0.0)) or 0.0),
                            "start": value.get("start"),
                            "end": value.get("end"),
                        }
                    )
                else:
                    normalized.append({"text": value, "label": canonical_label, "score": None, "start": None, "end": None})
        elif values:
            normalized.append({"text": values, "label": canonical_label, "score": None, "start": None, "end": None})

    return _unique_entities(normalized)


def _normalize_gliner2_relations(result: Dict[str, Any]) -> List[Dict[str, Any]]:
    relation_payload = result.get("relation_extraction") if isinstance(result, dict) else {}
    normalized: List[Dict[str, Any]] = []
    if not isinstance(relation_payload, dict):
        return normalized

    for relation_label, items in relation_payload.items():
        mapped = _normalize_relation_label(str(relation_label))
        if mapped is None:
            continue
        relation, metadata = mapped
        if not isinstance(items, list):
            continue
        for item in items:
            if isinstance(item, dict):
                head = item.get("head") if isinstance(item.get("head"), dict) else {}
                tail = item.get("tail") if isinstance(item.get("tail"), dict) else {}
                normalized.append(
                    {
                        "source": head.get("text"),
                        "target": tail.get("text"),
                        "relation": relation,
                        "score": float(head.get("confidence", item.get("confidence", 0.0)) or 0.0),
                        "start": head.get("start"),
                        "end": tail.get("end"),
                        **metadata,
                    }
                )
            elif isinstance(item, (tuple, list)) and len(item) >= 2:
                normalized.append(
                    {
                        "source": item[0],
                        "target": item[1],
                        "relation": relation,
                        "score": None,
                        **metadata,
                    }
                )

    return _unique_relations(_filter_invalid_relations(normalized))


def _filter_invalid_relations(relations: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    filtered: List[Dict[str, Any]] = []
    for relation in relations:
        source = _normalize_text(str(relation.get("source", "")))
        target = _normalize_text(str(relation.get("target", "")))
        predicate = _normalize_text(str(relation.get("relation", "")))
        if not source or not target or not predicate:
            continue
        if source.lower() == target.lower():
            continue
        if predicate not in {
            "friend_of",
            "works_with",
            "works_at",
            "worked_at",
            "works_on",
            "lives_in",
            "lived_in",
            "member_of",
            "met_through",
            "sibling_of",
            "was_with",
        }:
            continue
        filtered.append(relation)
    return filtered


def _run_gliner2_legacy(scene: SceneInput, model_id: str, device: str, entity_labels: List[str], thresholds: Dict[str, float]) -> Dict[str, Any]:
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
        "relations": _filter_invalid_relations(_heuristic_relations(scene.text, normalized_entities)),
        "warnings": [],
        "schema_version": "gliner2_dynamic_v1",
        "thresholds": {
            "entity": entity_threshold,
            "adjacency": float(thresholds.get("adjacency", entity_threshold)),
            "relation": float(thresholds.get("relation", entity_threshold)),
        },
    }


def _run_gliner2(
    scene: SceneInput,
    model_id: str,
    device: str,
    entity_labels: List[str],
    relation_labels: List[str],
    thresholds: Dict[str, float],
    classification_tasks: Optional[Dict[str, Any]] = None,
    structure_schemas: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    entity_threshold = float(thresholds.get("entity", 0.45))
    relation_threshold = float(thresholds.get("relation", entity_threshold))
    classification_threshold = float(thresholds.get("classification", max(entity_threshold, 0.6)))
    structure_threshold = float(thresholds.get("structure", max(entity_threshold, 0.65)))

    try:
        extractor = _load_gliner2_model(model_id, device)
        entity_result = extractor.extract_entities(scene.text, entity_labels, threshold=entity_threshold)
        relation_result = extractor.extract_relations(scene.text, relation_labels, threshold=relation_threshold)
        classifications = (
            extractor.classify_text(scene.text, classification_tasks, threshold=classification_threshold)
            if classification_tasks
            else None
        )
        structures = extractor.extract_json(scene.text, structure_schemas, threshold=structure_threshold) if structure_schemas else None
        return {
            "entities": _normalize_gliner2_entities(entity_result),
            "relations": _normalize_gliner2_relations(relation_result),
            "classifications": _attach_meta(classifications, "task_confidence"),
            "structures": _attach_meta(structures, "structure_confidence"),
            "warnings": [],
            "schema_version": "gliner2_native_v2",
            "thresholds": {
                "entity": entity_threshold,
                "adjacency": float(thresholds.get("adjacency", entity_threshold)),
                "relation": relation_threshold,
                "classification": classification_threshold,
                "structure": structure_threshold,
            },
        }
    except Exception as exc:
        try:
            fallback = _run_gliner2_legacy(scene, model_id, device, entity_labels, thresholds)
        except Exception as legacy_exc:
            return {
                "entities": [],
                "relations": [],
                "classifications": None,
                "structures": None,
                "warnings": [f"gliner2 native failed: {exc}", f"gliner2 legacy fallback failed: {legacy_exc}"],
                "schema_version": "gliner2_unavailable_v2",
                "thresholds": {
                    "entity": entity_threshold,
                    "adjacency": float(thresholds.get("adjacency", entity_threshold)),
                    "relation": relation_threshold,
                    "classification": classification_threshold,
                    "structure": structure_threshold,
                },
            }
        return {
            **fallback,
            "warnings": [*fallback.get("warnings", []), f"gliner2 native fallback: {exc}"],
            "schema_version": "gliner2_legacy_fallback_v2",
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
        "relations": _filter_invalid_relations(_heuristic_relations(scene.text, entities)),
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
        "relations": _filter_invalid_relations(_heuristic_relations(scene.text, normalized_entities)),
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
    classification_tasks: Optional[Dict[str, Any]] = None,
    structure_schemas: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    try:
        if extractor in {"gliner_relex", "gliner_relex_v1"}:
            return _run_gliner_relex(
                scene,
                models.get(extractor, models["gliner_relex"]),
                device,
                entity_labels,
                relation_labels,
                entity_descriptions,
                relation_descriptions,
                thresholds,
            )
        if extractor == "gliner2":
            return _run_gliner2(
                scene,
                models["gliner2"],
                device,
                entity_labels,
                relation_labels,
                thresholds,
                classification_tasks,
                structure_schemas,
            )
        if extractor == "spacy":
            return _run_spacy(scene, models["spacy"])
        if extractor == "span_marker":
            return _run_span_marker(scene, models["span_marker"])
        if extractor in {"glirel", "flair", "stanza"}:
            return _run_eval_only_placeholder(extractor, scene)
        return _unavailable(extractor, f"Unsupported extractor: {extractor}")
    except Exception as exc:  # pragma: no cover - surfaced as tool/runtime metadata
        return _unavailable(extractor, f"{extractor} failed: {exc}")


def _build_response(payload: Dict[str, Any]) -> Dict[str, Any]:
    device = payload.get("device", "cpu")
    extractors = payload.get("extractors") or ["gliner_relex_v1", "gliner2", "spacy", "span_marker"]
    entity_labels = payload.get("entity_labels") or DEFAULT_ENTITY_LABELS
    relation_labels = payload.get("relation_labels") or DEFAULT_RELATION_LABELS
    entity_descriptions = payload.get("entity_descriptions") or {}
    relation_descriptions = payload.get("relation_descriptions") or {}
    thresholds = payload.get("thresholds") or {}
    classification_tasks = payload.get("classification_tasks") if isinstance(payload.get("classification_tasks"), dict) else None
    structure_schemas = payload.get("structure_schemas") if isinstance(payload.get("structure_schemas"), dict) else None
    model_config = payload.get("models") or {}

    models = {
        "gliner_relex": model_config.get("gliner_relex", model_config.get("gliner_relex_v1", "knowledgator/gliner-relex-large-v1.0")),
        "gliner_relex_v1": model_config.get("gliner_relex_v1", model_config.get("gliner_relex", "knowledgator/gliner-relex-large-v1.0")),
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
                classification_tasks,
                structure_schemas,
            )
            scene_result["extractors"].append(
                {
                    "extractor": extractor,
                    "model_id": models.get(extractor),
                    "schema_version": result.get("schema_version"),
                    "thresholds": result.get("thresholds"),
                    "entities": result["entities"],
                    "relations": result["relations"],
                    "classifications": result.get("classifications"),
                    "structures": result.get("structures"),
                    "warnings": result["warnings"],
                }
            )
        response["scenes"].append(scene_result)

    return response


def _daemon_main() -> int:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id = None
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("daemon message must be a JSON object")
            request_id = message.get("request_id")
            command = str(message.get("command") or "infer")
            if command == "shutdown":
                json.dump({"request_id": request_id, "response": {"ok": True, "shutdown": True}}, sys.stdout)
                sys.stdout.write("\n")
                sys.stdout.flush()
                return 0
            payload = message.get("payload")
            if not isinstance(payload, dict):
                raise ValueError("daemon infer message missing object payload")
            response = _build_response(payload)
            json.dump({"request_id": request_id, "response": response}, sys.stdout)
            sys.stdout.write("\n")
            sys.stdout.flush()
        except Exception as exc:  # pragma: no cover - surfaced to Node runtime
            json.dump({"request_id": request_id, "error": str(exc)}, sys.stdout)
            sys.stdout.write("\n")
            sys.stdout.flush()
    return 0


def main() -> int:
    if "--daemon" in sys.argv[1:]:
        return _daemon_main()

    payload = json.load(sys.stdin)
    response = _build_response(payload)
    json.dump(response, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
