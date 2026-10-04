"""Red flags read from filing text (roadmap 12.4). Every sentence here is quoted from a real
filing in the measurement (tasks/roadmap.md, 12.4): positives the detector must catch, and the
hard negatives that tripped an earlier version of it."""

import pytest

from app.services import red_flags

TOC = "Item 9A. Controls and Procedures 70 Item 9B. Other Information 72"
FILLER = "The Company designs and sells consumer products."

# Workhorse, PAVmed, Rekor, Veritone, America's Car-Mart (FY2025 10-Ks).
GOING_CONCERN = [
    "As a result of our recurring losses from operations, accumulated deficit, projected capital "
    "needs, delays in bringing our vehicles to market and lower than expected market demand, "
    "management determined that substantial doubt exists regarding our ability to continue as a "
    "going concern within one year.",
    "We have concluded there is substantial doubt of our ability to continue as a going concern.",
    "These factors raise substantial doubt regarding the Company's ability to continue as a going "
    "concern.",
    "These conditions collectively raise substantial doubt about the Company's ability to "
    "continue as a going concern.",
]

# Risk factors, ASC 205-40 policy notes and a clean conclusion (Wintrust, Car-Mart, PAVmed).
NOT_GOING_CONCERN = [
    "In connection with preparing financial statements for each reporting period, the Company "
    "evaluates whether conditions or events, considered in the aggregate, exist that would raise "
    "substantial doubt about the Company's ability to continue as a going concern.",
    "Through its evaluation, the Company did not identify any conditions or events that would "
    "raise substantial doubt about the Company's ability to continue as a going concern.",
    "In addition, the existence of substantial doubt about the Company's ability to continue as a "
    "going concern could adversely affect the Company's relationships with customers.",
    "However, there can be no assurance that any such financing will be available, and these "
    "plans have not alleviated the substantial doubt about the Company's ability to continue as a "
    "going concern.",
]

# Synlogic, Turtle Beach, Veritone (FY2025 10-Ks).
WEAKNESS = [
    "Based upon the evaluation, our Principal Executive Officer and Principal Financial Officer "
    "concluded that, as of December 31, 2025, our disclosure controls and procedures were not "
    "effective at a reasonable assurance level as a result of the material weakness that existed "
    "in our internal control over financial reporting.",
    "Based upon that evaluation, our PEO and PFO concluded that our disclosure controls and "
    "procedures were not effective as of December 31, 2025 due to the material weakness in our "
    "internal control over financial reporting described below.",
]

# The auditor's scope paragraph in every large filer's 9A (MSFT, PFE, WTFC), the definition, and
# a prior year's weakness since fixed (Car-Mart).
NOT_WEAKNESS = [
    "Our audit included obtaining an understanding of internal control over financial reporting, "
    "assessing the risk that a material weakness exists, testing and evaluating the design and "
    "operating effectiveness of internal control based on the assessed risk.",
    "A material weakness is a deficiency, or a combination of deficiencies, in internal control "
    "over financial reporting.",
    "As previously disclosed in Item 9A of the Company's Annual Report on Form 10-K for the year "
    "ended April 30, 2025, the Company identified a material weakness in its internal control.",
    "Based on the results of this testing, management concluded that the previously reported "
    "material weakness was remediated as of April 30, 2026.",
]


def ten_k_with_9a(body: str, heading: str = "Item 9A. Controls and Procedures") -> str:
    return f"{TOC}\n{FILLER}\n{heading}\n{body}\nItem 9B. Other Information\n{FILLER}"


@pytest.mark.parametrize("sentence", GOING_CONCERN)
def test_a_stated_going_concern_doubt_is_flagged(sentence):
    assert red_flags.going_concern_sentence(f"{FILLER} {sentence} {FILLER}") == sentence


@pytest.mark.parametrize("sentence", NOT_GOING_CONCERN)
def test_a_hypothetical_or_policy_going_concern_sentence_is_not(sentence):
    assert red_flags.going_concern_sentence(f"{FILLER} {sentence} {FILLER}") is None


@pytest.mark.parametrize("sentence", WEAKNESS)
def test_a_stated_material_weakness_in_9a_is_flagged(sentence):
    assert red_flags.material_weakness_sentence(ten_k_with_9a(sentence), "10-K") == sentence


@pytest.mark.parametrize("sentence", NOT_WEAKNESS)
def test_boilerplate_definitions_and_remediated_weaknesses_are_not(sentence):
    assert red_flags.material_weakness_sentence(ten_k_with_9a(sentence), "10-K") is None


def test_a_weakness_outside_the_controls_section_is_not_flagged():
    # Risk factors restate old weaknesses; only Item 9A's conclusion counts.
    text = f"{TOC}\nItem 1A. Risk Factors\n{WEAKNESS[0]}\nItem 9A. Controls and Procedures\n{FILLER}"
    assert red_flags.material_weakness_sentence(text, "10-K") is None


def test_no_controls_section_means_no_flag():
    assert red_flags.material_weakness_sentence(f"{FILLER} {WEAKNESS[0]}", "10-K") is None


def test_the_table_of_contents_entry_is_skipped_for_the_heading():
    # The TOC lists "Item 9A ... Item 9B" first; the last heading is the real section.
    text = ten_k_with_9a(WEAKNESS[1])
    assert red_flags.material_weakness_sentence(text, "10-K") == WEAKNESS[1]


def test_a_heading_split_mid_word_by_text_extraction_still_matches():
    # Turtle Beach's FY2025 10-K, exactly as BeautifulSoup renders it.
    text = ten_k_with_9a(WEAKNESS[1], heading="Item 9A - Contro\nls and Procedures")
    assert red_flags.material_weakness_sentence(text, "10-K") == WEAKNESS[1]


def test_a_10q_reads_part_i_item_4():
    text = (
        "Item 4. Controls and Procedures 40 PART II 41\n"
        f"{FILLER}\nItem 4. Controls and Procedures\n{WEAKNESS[0]}\nPART II. OTHER INFORMATION"
    )
    assert red_flags.material_weakness_sentence(text, "10-Q") == WEAKNESS[0]
    assert red_flags.material_weakness_sentence(text, "10-Q/A") == WEAKNESS[0]


def test_detect_returns_both_kinds_with_source_and_a_capped_excerpt():
    long_going_concern = GOING_CONCERN[0]
    text = f"{FILLER} {long_going_concern} " + ten_k_with_9a(WEAKNESS[1])
    flags = red_flags.detect_text_flags(text, "10-K", "2026-03-31", "000162828026022417")

    assert [f.kind for f in flags] == ["going_concern", "material_weakness"]
    assert all(f.accession_number == "000162828026022417" for f in flags)
    assert all(f.filed_date == "2026-03-31" and f.form_type == "10-K" for f in flags)
    excerpt = flags[0].excerpt
    assert excerpt is not None and len(excerpt) <= 301
    assert excerpt.endswith("…") == (len(long_going_concern) > 300)


def test_a_clean_filing_has_no_flags():
    text = f"{FILLER} " + ten_k_with_9a(NOT_WEAKNESS[0]) + " " + NOT_GOING_CONCERN[1]
    assert red_flags.detect_text_flags(text, "10-K", "2026-03-31", "x") == []
