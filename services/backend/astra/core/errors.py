from pydantic import ValidationError


class ProtocolError(Exception):
    """One or more protocol files are invalid. The app refuses to start (fail fast)."""

    def __init__(self, problems: list[str]) -> None:
        self.problems = problems
        super().__init__("Invalid protocol files:\n- " + "\n- ".join(problems))


def describe_validation_error(exc: ValidationError) -> str:
    """Short, readable summary: 'when.all.0.op: Input should be ...; version: String should ...'."""
    parts = []
    for err in exc.errors():
        location = ".".join(str(p) for p in err["loc"]) or "(file)"
        parts.append(f"{location}: {err['msg']}")
    return "; ".join(parts)
