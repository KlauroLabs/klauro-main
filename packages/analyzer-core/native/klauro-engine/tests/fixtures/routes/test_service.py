from unittest import mock


@mock.patch("Product")
def test_product(target):
    assert target


@patch("delay")
def test_delay(target):
    assert target
