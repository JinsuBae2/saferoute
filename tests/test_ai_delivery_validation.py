import pytest

from tools.validate_ai_delivery import check_observation_freshness


@pytest.mark.parametrize("ages,gaps", [([1000, 0], [2500]), ([1000, 0], [2000]),
                                       ([0, 3000], [500]), ([-1, 0], [500]),
                                       ([0, 0], [-1]), ([0, 0], [])])
def test_freshness_rejects_expiry_or_invalid_measurements(ages, gaps):
    with pytest.raises(ValueError, match="freshness"):
        check_observation_freshness(ages, gaps, 3000)


def test_freshness_uses_each_observations_remaining_lifetime():
    assert check_observation_freshness([1000, 0], [1999], 3000) == 2999
    assert check_observation_freshness([0, 1000, 0], [2500, 500], 3000) == 2500


def test_freshness_rejects_recorded_expiry_before_eof_even_with_short_observation_gaps():
    with pytest.raises(ValueError, match="source expired"):
        check_observation_freshness([0, 0], [500], 3000, source_expirations=1)
