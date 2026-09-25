#[test]
#[ignore = "requires FLINT_VFX_SKN pointing to an extracted skin"]
fn resolves_extracted_skin_idle_particles() {
    let path = std::env::var("FLINT_VFX_SKN").expect("FLINT_VFX_SKN");
    let result = flint_core::mesh::idle_effects::read_idle_effects(std::path::Path::new(&path));
    println!("{} idle attachments, warnings: {:?}", result.attachments.len(), result.warnings);
    assert!(!result.attachments.is_empty(), "fixture must have idle effects");
    assert!(result.warnings.is_empty());
    for attachment in &result.attachments {
        assert_eq!(attachment["system"]["root"]["type"], "struct");
        assert!(!attachment["system"]["root"]["fields"].as_array().unwrap().is_empty());
    }
}
