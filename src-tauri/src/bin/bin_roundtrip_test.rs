//! Simple BIN roundtrip test tool
//!
//! Usage: cargo run --bin bin_roundtrip_test -- <path_to_bin_file>
//!
//! This tool:
//! 1. Reads a BIN file
//! 2. Parses it with rs_bin (`Bin::from_bytes`)
//! 3. Writes it back using rs_bin (`bin.to_bytes()`)
//! 4. Compares the sizes and entry counts
//! 5. Converts both to ritobin text and round-trips text -> bin -> text
//! 6. Outputs both versions for comparison

use std::env;
use std::fs;
use std::path::Path;

use flint_ltk::ltk_types::{Bin, HashMapper};
use ritoshark::bin::{from_text, to_text};
use ritoshark::prelude::{Parse as _, Serialize as _};

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        eprintln!("Usage: {} <path_to_bin_file>", args[0]);
        eprintln!("Example: {} C:/path/to/skin0.bin", args[0]);
        std::process::exit(1);
    }

    let input_path = Path::new(&args[1]);

    if !input_path.exists() {
        eprintln!("ERROR: File not found: {}", input_path.display());
        std::process::exit(1);
    }

    println!("=== BIN Roundtrip Test ===\n");
    println!("Input file: {}", input_path.display());

    // Step 1: Read original file
    let original_data = fs::read(input_path).expect("Failed to read input file");
    let original_size = original_data.len();

    println!("\n--- Step 1: Original File ---");
    println!("Size: {} bytes", original_size);
    println!("Magic: {:?}", String::from_utf8_lossy(&original_data[0..4]));

    // Step 2: Parse with rs_bin
    println!("\n--- Step 2: Parsing with rs_bin ---");
    let bin = match Bin::from_bytes(&original_data) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("ERROR: Failed to parse BIN: {:?}", e);
            std::process::exit(1);
        }
    };

    println!("Entries count: {}", bin.entries.len());
    println!("Linked count: {}", bin.linked.len());

    // List entries
    println!("\nEntries (path hashes):");
    for entry in &bin.entries {
        println!(
            "  0x{:08x} (class: 0x{:08x}) - {} fields",
            entry.path_hash,
            entry.class_hash,
            entry.fields.len()
        );
    }

    // List linked files
    if !bin.linked.is_empty() {
        println!("\nLinked (dependency BINs):");
        for dep in &bin.linked {
            println!("  {}", dep);
        }
    }

    // Step 3: Write back with rs_bin
    println!("\n--- Step 3: Writing back with rs_bin ---");
    let output_data = match bin.to_bytes() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("ERROR: Failed to write BIN: {:?}", e);
            std::process::exit(1);
        }
    };
    let output_size = output_data.len();

    println!("Output size: {} bytes", output_size);
    println!("Size difference: {} bytes", output_size as i64 - original_size as i64);

    // Step 4: Re-parse the output to verify
    println!("\n--- Step 4: Re-parsing output ---");
    let verify = match Bin::from_bytes(&output_data) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("ERROR: Failed to re-parse output: {:?}", e);
            std::process::exit(1);
        }
    };

    println!("Verified entries count: {}", verify.entries.len());
    println!("Verified linked count: {}", verify.linked.len());

    // Step 5: Compare
    println!("\n--- Step 5: Comparison ---");
    let entries_match = bin.entries.len() == verify.entries.len();
    let linked_match = bin.linked.len() == verify.linked.len();
    let bytes_match = original_data == output_data;

    if entries_match {
        println!("[ok] Entry count matches: {}", bin.entries.len());
    } else {
        println!("[!!] Entry count MISMATCH: {} -> {}", bin.entries.len(), verify.entries.len());
    }

    if linked_match {
        println!("[ok] Linked count matches: {}", bin.linked.len());
    } else {
        println!("[!!] Linked count MISMATCH: {} -> {}", bin.linked.len(), verify.linked.len());
    }

    if bytes_match {
        println!("[ok] Binary output is byte-identical to input");
    } else {
        println!("[!!] Binary output differs from input ({} -> {} bytes)", original_size, output_size);
    }

    // Step 6: Convert to text (WITH HASH RESOLUTION), then text -> bin -> text
    println!("\n--- Step 6: Converting to ritobin text with hash resolution ---");

    // Load hashes from RitoShark directory
    let mut hashes = HashMapper::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        let hash_dir = std::path::PathBuf::from(appdata)
            .join("RitoShark")
            .join("Requirements")
            .join("Hashes");

        if hash_dir.exists() {
            println!("Loading hashes from: {}", hash_dir.display());
            // CDTB dictionaries are `<hex> <name>` per line; merge every file in the
            // directory into one shared mapper (HashMapper has no cross-file merge,
            // so parse the lines directly).
            for entry in fs::read_dir(&hash_dir).into_iter().flatten().flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let text = match fs::read_to_string(&path) {
                    Ok(t) => t,
                    Err(e) => {
                        eprintln!("WARNING: failed to read {}: {:?}", path.display(), e);
                        continue;
                    }
                };
                for line in text.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Some((hex, name)) = trimmed.split_once(' ') {
                        if let Ok(h) = u64::from_str_radix(hex, 16) {
                            hashes.insert(h, name.to_string());
                        }
                    }
                }
            }
            println!("Loaded {} total hashes", hashes.len());
        } else {
            println!("WARNING: Hash directory not found: {}", hash_dir.display());
        }
    }

    let original_text = to_text(&bin, Some(&hashes));
    let output_text = to_text(&verify, Some(&hashes));

    // text -> bin -> text stability check
    println!("\n--- Step 7: text -> bin -> text round-trip ---");
    match from_text(&original_text, None) {
        Ok(reparsed) => {
            let retext = to_text(&reparsed, Some(&hashes));
            if retext == original_text {
                println!("[ok] text round-trip is stable");
            } else {
                println!("[!!] text round-trip DIFFERS (parse(text) -> text not identical)");
            }
        }
        Err(e) => {
            eprintln!("WARNING: Failed to re-parse text form: {:?}", e);
        }
    }

    // Save outputs
    let parent = input_path.parent().unwrap_or(Path::new("."));
    let stem = input_path.file_stem().unwrap_or_default().to_string_lossy();

    let output_bin_path = parent.join(format!("{}_roundtrip.bin", stem));
    let original_text_path = parent.join(format!("{}_original.ritobin", stem));
    let output_text_path = parent.join(format!("{}_roundtrip.ritobin", stem));

    fs::write(&output_bin_path, &output_data).expect("Failed to write output bin");
    fs::write(&original_text_path, &original_text).expect("Failed to write original text");
    fs::write(&output_text_path, &output_text).expect("Failed to write output text");

    println!("\nSaved files:");
    println!("  Binary: {}", output_bin_path.display());
    println!("  Original text: {}", original_text_path.display());
    println!("  Roundtrip text: {}", output_text_path.display());

    // Final verdict
    println!("\n=== VERDICT ===");
    if bytes_match && entries_match && linked_match {
        println!("[ok] Roundtrip appears SUCCESSFUL - byte-identical, no data loss");
    } else {
        println!("[!!] Roundtrip shows DIFFERENCES:");
        println!("   Size: {} -> {} ({} bytes)", original_size, output_size, output_size as i64 - original_size as i64);
        println!("   Entries: {} -> {}", bin.entries.len(), verify.entries.len());
        println!("   Linked: {} -> {}", bin.linked.len(), verify.linked.len());
    }

    println!("\nCompare the .ritobin files to see exactly what changed!");
    println!("   Use: diff {} {}", original_text_path.display(), output_text_path.display());
}
