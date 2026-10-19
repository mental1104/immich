#!/usr/bin/env python3
"""Build the bundled Chinese gazetteer from the same GeoNames snapshot as Immich.

python3 docker/geodata/update-geodata-zh.py --geodata /path/to/build/geodata \
    --alternate-names /path/to/alternateNamesV2.zip
"""

import argparse
from collections import Counter
import gzip
import hashlib
import io
import json
from pathlib import Path
import zipfile


LANGUAGE_PRIORITY = {"zh-Hans": 0, "zh-CN": 0, "zh-SG": 1, "zh": 2}
CHINESE_LANGUAGES = {*LANGUAGE_PRIORITY, "zh-Hant", "zh-TW", "zh-HK", "zh-MO"}


def build(geodata, archive):
    entities = {}
    countries = {}
    states = {}
    fingerprints = {}

    def add(geoname_id, kind, name, country, state=None):
        entities.setdefault(int(geoname_id), []).append(
            {"geonameId": int(geoname_id), "kind": kind, "name": name,
             "country": country, "state": state}
        )

    for filename in ("countryInfo.txt", "admin1CodesASCII.txt", "cities500.txt"):
        content = (geodata / filename).read_bytes()
        fingerprints[filename] = hashlib.sha256(content).hexdigest()
        for line in content.decode("utf-8").splitlines():
            if not line or line.startswith("#"):
                continue
            fields = line.split("\t")
            if filename == "countryInfo.txt":
                countries[fields[0]] = fields[4]
                if fields[16]:
                    add(fields[16], "country", fields[4], fields[4])
            elif filename == "admin1CodesASCII.txt":
                states[fields[0]] = fields[1]
                country = countries.get(fields[0].split(".")[0])
                if country and fields[3]:
                    add(fields[3], "state", fields[1], country)
            else:
                if (fields[7] == "PPLX" and fields[8] != "AU") or fields[7] == "PPLH":
                    continue
                country = countries.get(fields[8])
                if country:
                    add(fields[0], "city", fields[1], country,
                        states.get(f"{fields[8]}.{fields[10]}"))

    all_entities = [entity for entries in entities.values() for entity in entries]
    global_names = Counter((entry['kind'], entry['name'].casefold()) for entry in all_entities)
    country_names = Counter((entry['kind'], entry['country'], entry['name'].casefold()) for entry in all_entities)
    state_names = Counter((entry['kind'], entry['country'], entry['state'], entry['name'].casefold()) for entry in all_entities)
    for entity in all_entities:
        kind, name, country, state = entity['kind'], entity['name'].casefold(), entity['country'], entity['state']
        entity['scope'] = ('global' if global_names[kind, name] == 1 else
                           'country' if country_names[kind, country, name] == 1 else
                           'state' if state is not None and state_names[kind, country, state, name] == 1 else 'none')

    names = {}
    with zipfile.ZipFile(archive) as zipped:
        with zipped.open("alternateNamesV2.txt") as source:
            for line in io.TextIOWrapper(source, encoding="utf-8"):
                fields = line.rstrip("\r\n").split("\t")
                if len(fields) < 8 or fields[2] not in CHINESE_LANGUAGES:
                    continue
                geoname_id = int(fields[1])
                # 历史名称和已失效名称不参与当前地点显示或筛选。
                if geoname_id not in entities or fields[7] == "1" or (len(fields) > 9 and fields[9]):
                    continue
                names.setdefault(geoname_id, []).append(fields)

    rows = []
    for geoname_id, variants in names.items():
        candidates = [entry for entry in variants if entry[2] in LANGUAGE_PRIORITY and entry[6] != "1"]
        candidates.sort(key=lambda entry: (LANGUAGE_PRIORITY[entry[2]], entry[4] != "1", entry[5] == "1", int(entry[0])))
        aliases = sorted({entry[3] for entry in variants if entry[3]})
        for entity in entities[geoname_id]:
            rows.append({**entity, "localizedName": candidates[0][3] if candidates else entity["name"],
                         "aliases": aliases})
    rows.sort(key=lambda row: (row["kind"], row["geonameId"]))
    return {"format": 1, "source": "https://download.geonames.org/export/dump/alternateNamesV2.zip",
            "sourceSha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
            "baseFiles": fingerprints, "rows": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--geodata", required=True, type=Path)
    parser.add_argument("--alternate-names", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=Path("server/resources/geodata-zh.json.gz"))
    args = parser.parse_args()
    catalog = build(args.geodata, args.alternate_names)
    if not catalog["rows"]:
        raise RuntimeError("No Chinese names found; refusing to replace the catalog")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(catalog, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_bytes(gzip.compress(content, mtime=0))
    temporary.replace(args.output)
    print(json.dumps({"records": len(catalog["rows"]), "bytes": args.output.stat().st_size,
                      "sourceSha256": catalog["sourceSha256"]}))


if __name__ == "__main__":
    main()
