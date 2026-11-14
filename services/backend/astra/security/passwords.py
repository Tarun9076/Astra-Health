import bcrypt

# Used to spend the same time on unknown usernames as on wrong passwords (no user enumeration).
_DUMMY_HASH = bcrypt.hashpw(b"astra-timing-equaliser", bcrypt.gensalt(rounds=4)).decode("ascii")


def hash_password(password: str, rounds: int = 12) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=rounds)).decode("ascii")


def verify_password(password: str, password_hash: str | None) -> bool:
    if password_hash is None:
        bcrypt.checkpw(password.encode("utf-8"), _DUMMY_HASH.encode("ascii"))
        return False
    return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("ascii"))
