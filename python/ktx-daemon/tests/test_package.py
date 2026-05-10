from ktx_daemon import PACKAGE_NAME, VERSION


def test_package_metadata() -> None:
    assert PACKAGE_NAME == "ktx-daemon"
    assert VERSION == "0.1.0"
