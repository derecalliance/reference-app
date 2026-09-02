//! Generate the `DeRecTransport` gRPC service from the sibling `lib-derec`
//! checkout.
//!
//! `extern_path` maps the proto package onto `derec_proto` so the generated
//! service speaks the exact `DeRecMessage` the library hands `DeRecTransport`,
//! with no re-encode across a duplicate definition. This is the recipe the
//! library's own `smoke-tests/grpc` uses.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto_root = "../../../lib-derec/protobufs";
    println!("cargo:rerun-if-changed={proto_root}/grpc/derectransport.proto");
    println!("cargo:rerun-if-changed={proto_root}/protobufs/derecmessage.proto");

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
