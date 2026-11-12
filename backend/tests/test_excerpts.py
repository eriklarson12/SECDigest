import pytest

from app.services.excerpts import display_excerpt


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        # The two openings roadmap 16.9 quotes from analysis 150's sources.
        ("reased during 2026 due to higher net sales.", "…during 2026 due to higher net sales."),
        ("ated sales on a net basis.", "…sales on a net basis."),
        # A number's tail would read as a real figure, so it goes too.
        ("78.8 billion in total net sales.", "…billion in total net sales."),
        # The dropped fragment ended a sentence, so the excerpt opens one.
        ("ed. The Company sells iPhone.", "The Company sells iPhone."),
        ('ny." Net sales rose.', "Net sales rose."),
        # A full stop before a lowercase word is an abbreviation, not a sentence end.
        ("approx. the same as last year.", "…the same as last year."),
        # A clause's tail.
        (", and the Company expects growth.", "…and the Company expects growth."),
        ("%, primarily due to iPhone.", "…primarily due to iPhone."),
        # A capital or an opening mark is kept as a word, but the window's start is unknown.
        ("Greater China net sales fell.", "…Greater China net sales fell."),
        ("$478.8 billion in net sales.", "…$478.8 billion in net sales."),
        ("(1) Includes Services.", "…(1) Includes Services."),
        # Line breaks from the filing are whitespace like any other.
        ("eased\nduring 2026.", "…during 2026."),
        # Nothing to cut back to: shown as it is.
        ("fragment", "…fragment"),
    ],
)
def test_the_excerpt_starts_on_a_word(content, expected):
    assert display_excerpt(content, chunk_index=5) == expected


def test_the_filings_first_chunk_is_kept_whole():
    assert display_excerpt("annual report pursuant to Section 13", 0) == (
        "annual report pursuant to Section 13"
    )


def test_the_excerpt_ends_on_a_word_near_the_limit():
    words = "Net sales of iPhone, Mac and Services increased, " * 20
    excerpt = display_excerpt(words, 3, limit=100)
    assert excerpt.startswith("…Net sales")
    body = excerpt[1:]
    assert len(body) <= 100
    assert words.startswith(body)
    assert words[len(body)] in " ,"
    assert not body.endswith(",")


def test_one_long_token_is_cut_at_the_limit():
    assert display_excerpt("A" + "x" * 400, 3, limit=300) == "…A" + "x" * 299


def test_blank_content_stays_blank():
    assert display_excerpt("   ", 3) == ""
