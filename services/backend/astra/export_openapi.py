"""Write the API's OpenAPI schema to a file, for the web app's generated TypeScript types.

python -m astra.export_openapi ../../apps/web/openapi.json
(then in apps/web:  npm run gen:api)
"""

import json
import sys
from pathlib import Path

from astra.main import create_app


def main() -> None:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("openapi.json")
    target.write_text(
        json.dumps(create_app().openapi(), indent=1, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"Wrote {target}")


if __name__ == "__main__":
    main()
