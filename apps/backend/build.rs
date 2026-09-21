fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Vendored from the published `derec-proto` crate rather than read from a
    // sibling checkout: a Docker build context rooted at this repo cannot see
    // a sibling, and the crate exposes no supported way to locate the copies it
    // ships. `tests/proto_drift.rs` guards these against the pinned release.
    let proto_root = "proto";

    println!("cargo:rerun-if-changed={proto_root}");

    tonic_prost_build::configure()
        .build_server(true)
        .build_client(true)
        .extern_path(".org.derecalliance.derec.protobuf", "::derec_proto")
        .compile_protos(
            &[format!("{proto_root}/grpc/derectransport.proto")],
            &[
                format!("{proto_root}/grpc"),
                format!("{proto_root}/protobufs"),
            ],
        )?;
    Ok(())
}
