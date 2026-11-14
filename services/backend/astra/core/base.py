from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CoreModel(BaseModel):
    """Base for protocol/domain models: camelCase in JSON files, snake_case in Python.

    `extra="forbid"` turns a typo in a protocol file (e.g. "sigmaFlor") into a load error
    instead of a silently ignored field. Models are immutable once loaded.
    """

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True)
