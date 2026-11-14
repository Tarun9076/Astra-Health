from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class ApiModel(BaseModel):
    """Base for every request/response body: snake_case in Python, camelCase in JSON.

    Keeps the generated TypeScript client idiomatic and matches the LLD examples.
    """

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
