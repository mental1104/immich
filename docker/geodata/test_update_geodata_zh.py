import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("geodata_zh", Path(__file__).with_name("update-geodata-zh.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class GeodataChineseTest(unittest.TestCase):
    def test_language_priority_and_ambiguity_use_the_complete_base(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            country = ["CN", "CHN", "156", "CH", "China"] + [""] * 12
            country[16] = "100"
            (root / "countryInfo.txt").write_text("\t".join(country), encoding="utf8")
            (root / "admin1CodesASCII.txt").write_text("CN.01\tOne\tOne\t200\nCN.02\tTwo\tTwo\t201", encoding="utf8")
            cities = []
            for identifier, state in ((300, "01"), (301, "02")):
                city = [str(identifier), "Lakeside", "Lakeside", "", "1", "2", "P", "PPL", "CN", "", state] + [""] * 8
                cities.append("\t".join(city))
            (root / "cities500.txt").write_text("\n".join(cities), encoding="utf8")
            rows = [
                ["1", "300", "zh-Hant", "湖邊", "1", "", "", ""],
                ["2", "300", "zh", "湖边", "", "", "", ""],
                ["3", "300", "zh-Hans", "湖畔", "1", "", "", ""],
                ["4", "300", "zh", "旧名", "1", "", "", "1"],
                ["5", "999", "zh", "未知地点", "1", "", "", ""],
                ["6", "300", "ja", "日文名称", "1", "", "", ""],
                ["7", "300", "zh", "已失效名称", "1", "", "", "", "", "2001"],
            ]
            archive = root / "alternateNamesV2.zip"
            with zipfile.ZipFile(archive, "w") as zipped:
                zipped.writestr("alternateNamesV2.txt", "\n".join("\t".join(row) for row in rows))
            catalog = module.build(root, archive)
            self.assertEqual(len(catalog["rows"]), 1)
            row = catalog["rows"][0]
            self.assertEqual(row["localizedName"], "湖畔")
            self.assertEqual(set(row["aliases"]), {"湖邊", "湖边", "湖畔"})
            self.assertEqual(row["scope"], "state")
            self.assertEqual(row["name"], "Lakeside")
            self.assertEqual(set(catalog["baseFiles"]), {"countryInfo.txt", "admin1CodesASCII.txt", "cities500.txt"})


if __name__ == "__main__":
    unittest.main()
